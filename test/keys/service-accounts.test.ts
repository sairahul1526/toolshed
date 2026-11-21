import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  createServiceAccount,
  deleteServiceAccount,
  getServiceAccount,
  listApiKeys,
  listServiceAccounts,
  MAX_SERVICE_ACCOUNTS,
  revokeKeysForUser,
  rotateApiKey,
  updateServiceAccount,
  verifyApiKey,
} from '../../src/core/apikeys';
import type { KeyActor, KeyRole } from '../../src/core/apikeys';
import { registerModules } from '../../src/core/registry';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { actor, auditRows, DAY, failure, ORG_A, ORG_B, T0, tableRows, useModules } from './helpers';

let t: TestEnv;
const owner = actor('owner');
const admin = actor('admin');
const member = actor('member');

beforeEach(() => {
  t = createTestEnv();
  useModules();
});
afterEach(() => registerModules([]));

const account = (who: KeyActor = admin, name = 'Deploy bot', role: KeyRole = 'member', now = T0) => createServiceAccount(t.env, who, { name, role }, now);
const keyFor = (serviceAccountId: string, who: KeyActor = admin, now = T0) =>
  createApiKey(t.env, who, { name: 'Bot key', scopes: ['links:write'], serviceAccountId }, now);

describe('service accounts', () => {
  it('are made by admins and written to the audit log', async () => {
    const made = await account();
    expect(made).toMatchObject({ name: 'Deploy bot', role: 'member', createdBy: admin.userId, createdByLabel: admin.label, createdAt: T0, keyCount: 0 });
    expect(made.id).toMatch(/^svc_/);
    expect(await getServiceAccount(t.env, owner, made.id, T0)).toEqual(made);
    expect(auditRows(t, 'service_account.created')[0]).toMatchObject({
      org_id: ORG_A,
      actor_id: admin.userId,
      target_type: 'service_account',
      target_id: made.id,
      summary: 'Created the service account Deploy bot as Member',
    });
  });

  it('are hidden from everyone who is not an admin', async () => {
    const made = await account();
    for (const attempt of [
      () => account(member, 'Mine'),
      () => listServiceAccounts(t.env, member, T0),
      () => getServiceAccount(t.env, member, made.id, T0),
      () => updateServiceAccount(t.env, member, made.id, { name: 'Taken over' }, T0),
      () => deleteServiceAccount(t.env, member, made.id, T0),
      () => keyFor(made.id, member),
    ]) {
      const err = await failure(attempt);
      expect(err.code).toBe('forbidden');
      expect(err.status).toBe(403);
    }
    expect(tableRows(t, 'service_accounts')).toHaveLength(1);
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
  });

  it('can’t be changed with a key or a token', async () => {
    const made = await account();
    const byKey = { ...admin, via: 'apikey' as const };
    for (const attempt of [
      () => account(byKey, 'Another'),
      () => updateServiceAccount(t.env, byKey, made.id, { role: 'admin' }, T0),
      () => deleteServiceAccount(t.env, byKey, made.id, T0),
      () => keyFor(made.id, { ...admin, via: 'jwt' }),
    ]) {
      expect((await failure(attempt)).code).toBe('keys.session_required');
    }
    // Reading is fine.
    expect(await listServiceAccounts(t.env, byKey, T0)).toHaveLength(1);
  });

  it('need a name nobody else in the workspace uses', async () => {
    await account(admin, 'Deploy bot');
    const clash = await failure(() => account(owner, '  deploy BOT '));
    expect(clash.code).toBe('keys.name_taken');
    expect(clash.status).toBe(409);
    expect(clash.fields).toHaveProperty('name');
    // Another workspace can use the same name.
    expect((await account(actor('admin', 'usr_b', ORG_B), 'Deploy bot')).name).toBe('Deploy bot');
    expect((await failure(() => account(admin, ''))).fields).toHaveProperty('name');
  });

  it('never act as the owner', async () => {
    const err = await failure(() => account(owner, 'Root', 'owner' as never));
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toHaveProperty('role');
    expect((await account(owner, 'Ops', 'admin')).role).toBe('admin');
  });

  it('stop at the workspace limit', async () => {
    const insert = t.sqlite.prepare("INSERT INTO service_accounts (id, org_id, name, role, created_by, created_at) VALUES (?, ?, ?, 'viewer', 'usr_x', ?)");
    for (let i = 0; i < MAX_SERVICE_ACCOUNTS; i++) insert.run(`svc_fill_${i}`, ORG_A, `Filler ${i}`, T0);
    expect((await failure(() => account())).code).toBe('keys.too_many');
  });

  it('count the keys that still work', async () => {
    const made = await account();
    await keyFor(made.id);
    await createApiKey(t.env, admin, { name: 'Short', scopes: ['*'], serviceAccountId: made.id, expiresInDays: 1 }, T0);
    const other = await account(admin, 'Quiet bot', 'viewer', T0 + 1);
    expect((await listServiceAccounts(t.env, admin, T0)).map((a) => [a.name, a.keyCount])).toEqual([
      ['Deploy bot', 2],
      ['Quiet bot', 0],
    ]);
    expect((await getServiceAccount(t.env, admin, made.id, T0 + 2 * DAY)).keyCount).toBe(1);
    expect((await getServiceAccount(t.env, admin, other.id, T0)).keyCount).toBe(0);
  });
});

describe('service account keys', () => {
  it('act as the account, not as the admin who made them', async () => {
    const made = await account(owner, 'Deploy bot', 'member');
    const { key, secret } = await keyFor(made.id, owner);
    expect(key).toMatchObject({ kind: 'service', userId: null, serviceAccountId: made.id, serviceAccountName: 'Deploy bot', role: 'member', createdBy: owner.userId });
    expect(await verifyApiKey(t.env, secret, T0)).toMatchObject({ kind: 'service', userId: null, serviceAccountId: made.id, serviceAccountName: 'Deploy bot', role: 'member', orgId: ORG_A });
  });

  it('take the account’s role and refuse a different one', async () => {
    const made = await account(admin, 'Deploy bot', 'viewer');
    const err = await failure(() => createApiKey(t.env, admin, { name: 'Strong', scopes: ['*'], serviceAccountId: made.id, role: 'admin' }, T0));
    expect(err.code).toBe('validation_failed');
    expect(err.fields?.role).toContain('Viewer');
    const same = await createApiKey(t.env, admin, { name: 'Same', scopes: ['*'], serviceAccountId: made.id, role: 'viewer' }, T0);
    expect(same.key.role).toBe('viewer');
  });

  it('need an account that exists in this workspace', async () => {
    const elsewhere = await account(actor('admin', 'usr_b', ORG_B), 'Their bot');
    for (const id of ['svc_missing', elsewhere.id]) {
      const err = await failure(() => keyFor(id));
      expect(err.code).toBe('keys.service_account_not_found');
      expect(err.status).toBe(404);
    }
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
  });

  it('keep working when the admin who made them leaves', async () => {
    const leaver = actor('admin', 'usr_leaver');
    const made = await account(leaver);
    const service = await keyFor(made.id, leaver);
    const personal = await createApiKey(t.env, leaver, { name: 'Laptop', scopes: ['*'] }, T0);

    expect(await revokeKeysForUser(t.env, ORG_A, 'usr_leaver', T0 + 1)).toBe(1);
    expect(await verifyApiKey(t.env, personal.secret, T0 + 2)).toBeNull();
    expect(await verifyApiKey(t.env, service.secret, T0 + 2)).toMatchObject({ kind: 'service', role: 'member' });
    expect((await getServiceAccount(t.env, admin, made.id, T0 + 2)).keyCount).toBe(1);
  });

  it('follow the account when its role or name changes', async () => {
    const made = await account(admin, 'Deploy bot', 'admin');
    const { key, secret } = await keyFor(made.id);
    expect((await verifyApiKey(t.env, secret, T0))!.role).toBe('admin');

    const changed = await updateServiceAccount(t.env, admin, made.id, { role: 'viewer', name: 'Read bot' }, T0 + 1);
    expect(changed).toMatchObject({ id: made.id, name: 'Read bot', role: 'viewer', keyCount: 1 });
    expect(await verifyApiKey(t.env, secret, T0 + 1)).toMatchObject({ role: 'viewer', serviceAccountName: 'Read bot' });
    expect(tableRows<{ id: string; role: string }>(t, 'api_keys').find((r) => r.id === key.id)!.role).toBe('viewer');
    expect(auditRows(t, 'service_account.updated')[0]).toMatchObject({
      target_id: made.id,
      summary: 'Service account Read bot: renamed from Deploy bot to Read bot, role changed from Admin to Viewer',
    });

    // Nothing changed, nothing logged.
    await updateServiceAccount(t.env, admin, made.id, { name: 'Read bot' }, T0 + 2);
    expect(auditRows(t, 'service_account.updated')).toHaveLength(1);
  });

  it('refuse an update with nothing in it, a taken name or the owner role', async () => {
    const made = await account();
    await account(admin, 'Other bot');
    expect((await failure(() => updateServiceAccount(t.env, admin, made.id, {}, T0))).code).toBe('validation_failed');
    expect((await failure(() => updateServiceAccount(t.env, admin, made.id, { name: 'other BOT' }, T0))).code).toBe('keys.name_taken');
    expect((await failure(() => updateServiceAccount(t.env, admin, made.id, { role: 'owner' as never }, T0))).fields).toHaveProperty('role');
    expect((await failure(() => updateServiceAccount(t.env, admin, 'svc_missing', { name: 'X' }, T0))).code).toBe('keys.service_account_not_found');
  });

  it('are rotated by any admin and stay with the account', async () => {
    const made = await account(owner);
    const old = await keyFor(made.id, owner);
    const rotated = await rotateApiKey(t.env, admin, old.key.id, {}, T0 + 1);
    expect(rotated.key).toMatchObject({ kind: 'service', serviceAccountId: made.id, role: 'member', userId: null, rotatedFrom: old.key.id });
    expect(await verifyApiKey(t.env, old.secret, T0 + 1)).toBeNull();
    expect(await verifyApiKey(t.env, rotated.secret, T0 + 1)).not.toBeNull();
    expect((await failure(() => rotateApiKey(t.env, member, rotated.key.id, {}, T0 + 2))).code).toBe('not_found');
  });

  it('stop when the account is deleted, and the name is free again', async () => {
    const made = await account();
    const a = await keyFor(made.id);
    const b = await keyFor(made.id);
    const personal = await createApiKey(t.env, admin, { name: 'Laptop', scopes: ['*'] }, T0);

    expect(await deleteServiceAccount(t.env, admin, made.id, T0 + 5)).toEqual({ revokedKeys: 2 });
    expect(await verifyApiKey(t.env, a.secret, T0 + 5)).toBeNull();
    expect(await verifyApiKey(t.env, b.secret, T0 + 5)).toBeNull();
    expect(await verifyApiKey(t.env, personal.secret, T0 + 5)).not.toBeNull();
    expect(await listServiceAccounts(t.env, admin, T0 + 5)).toEqual([]);
    expect((await failure(() => getServiceAccount(t.env, admin, made.id, T0 + 5))).code).toBe('keys.service_account_not_found');
    expect((await failure(() => deleteServiceAccount(t.env, admin, made.id, T0 + 6))).code).toBe('keys.service_account_not_found');
    expect((await failure(() => keyFor(made.id, admin, T0 + 6))).code).toBe('keys.service_account_not_found');
    expect(auditRows(t, 'service_account.deleted')[0]).toMatchObject({ target_id: made.id, summary: 'Deleted the service account Deploy bot and revoked 2 keys' });

    const revoked = await listApiKeys(t.env, admin, { includeRevoked: true }, T0 + 6);
    expect(revoked.filter((k) => k.kind === 'service').map((k) => k.status)).toEqual(['revoked', 'revoked']);
    expect((await account(admin, 'Deploy bot', 'member', T0 + 7)).id).not.toBe(made.id);
  });
});

describe('workspaces are kept apart', () => {
  it('hides one workspace’s service accounts from another', async () => {
    const made = await account();
    const { secret } = await keyFor(made.id);
    const outsider = actor('owner', 'usr_outsider', ORG_B);

    expect(await listServiceAccounts(t.env, outsider, T0)).toEqual([]);
    for (const attempt of [
      () => getServiceAccount(t.env, outsider, made.id, T0),
      () => updateServiceAccount(t.env, outsider, made.id, { role: 'viewer' }, T0),
      () => deleteServiceAccount(t.env, outsider, made.id, T0),
      () => keyFor(made.id, outsider),
    ]) {
      expect((await failure(attempt)).code).toBe('keys.service_account_not_found');
    }
    expect(await verifyApiKey(t.env, secret, T0)).toMatchObject({ orgId: ORG_A, role: 'member', serviceAccountName: 'Deploy bot' });
    expect(auditRows(t).every((r) => r.org_id === ORG_A)).toBe(true);
  });
});
