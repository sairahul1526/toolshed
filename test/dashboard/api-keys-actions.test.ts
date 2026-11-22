import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createApiKey, createServiceAccount, verifyApiKey } from '../../src/core/apikeys';
import type { CreateKeyInput, KeyActor } from '../../src/core/apikeys';
import { getSigningKeyStatus, rotateSigningKey } from '../../src/core/jwt';
import { registerModules } from '../../src/core/registry';
import screen from '../../src/dashboard/api-keys';
import type { Role } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import type { TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { actor, auditRows, ORG_B, tableRows, useModules } from '../keys/helpers';

const ORG = 'org_test';
const BASE = '/app/api-keys';

interface KeyRow {
  id: string;
  name: string;
  kind: string;
  role: string;
  scopes: string;
  service_account_id: string | null;
  revoked_at: number | null;
  replaced_by: string | null;
}
interface AccountRow {
  id: string;
  name: string;
  role: string;
  deleted_at: number | null;
}

let t: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  t = createTestEnv();
  useModules();
  app = createApp({ screens: { 'api-keys': screen } });
});
afterEach(() => registerModules([]));

interface Who {
  session: TestSession;
  /** The same person as the service layer sees them, so keys made here belong to the session user. */
  actor: KeyActor;
}

async function signIn(role: Role = 'admin', opts: { instanceOwner?: boolean } = {}): Promise<Who> {
  const session = await createTestSession(t.env, { role, orgId: ORG, ...opts });
  return { session, actor: actor(role, session.user.id, ORG) };
}

function body(fields: Record<string, string | string[]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) for (const v of Array.isArray(value) ? value : [value]) params.append(name, v);
  return params.toString();
}

const send = (who: Who, path: string, fields: Record<string, string | string[]> = {}) =>
  app.request(path, { method: 'POST', headers: { ...who.session.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: body(fields) }, t.env);

const get = (who: Who, path: string) => app.request(path, { headers: who.session.headers }, t.env);

const tokenOf = (html: string) => /name="form_token" value="([^"]+)"/.exec(html)?.[1] ?? '';
const secretOf = (html: string) => /Bearer ([A-Za-z0-9_]+)/.exec(html)?.[1] ?? '';

async function freshToken(who: Who): Promise<string> {
  const token = tokenOf(await (await get(who, `${BASE}/new`)).text());
  expect(token).not.toBe('');
  return token;
}

/** The details a person fills in on the make-a-key form, with a fresh one-time token. */
async function keyForm(who: Who, fields: Record<string, string | string[]> = {}): Promise<Record<string, string | string[]>> {
  return { form_token: await freshToken(who), name: 'Zapier', account: '', role: 'member', expires: '90', scopes: ['links:read'], ...fields };
}

async function make(who: Who, input: Partial<CreateKeyInput> = {}) {
  return createApiKey(t.env, who.actor, { name: 'Deploy script', scopes: ['links:read'], expiresInDays: null, ...input });
}

const keys = () => tableRows<KeyRow>(t, 'api_keys');
const accounts = () => tableRows<AccountRow>(t, 'service_accounts');

describe('making a key', () => {
  it('shows the secret in the response to the post, once, and nowhere else', async () => {
    const who = await signIn();
    const res = await send(who, `${BASE}/new`, await keyForm(who));
    const html = await res.text();
    const secret = secretOf(html);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('set-cookie') ?? '').not.toContain(secret);
    expect(secret).toMatch(/^ts_/);
    expect(html).toContain('You won’t see this again');
    expect(html).toContain('data-copy');
    expect(html).toContain('curl http://localhost/api/v1/links');
    expect(html.split(secret).length - 1).toBeGreaterThanOrEqual(2);

    // Not in the database, the audit trail, or any page that comes after.
    expect(JSON.stringify(keys())).not.toContain(secret);
    expect(JSON.stringify(auditRows(t))).not.toContain(secret);
    const [row] = keys();
    for (const path of [BASE, `${BASE}?revoked=1`, `${BASE}/${row!.id}`, `${BASE}/new`]) {
      expect(await (await get(who, path)).text(), path).not.toContain(secret);
    }
    expect(await verifyApiKey(t.env, secret)).not.toBeNull();
  });

  it('writes one audit entry and makes a key with the details that were picked', async () => {
    const who = await signIn();
    await send(who, `${BASE}/new`, await keyForm(who, { name: 'Nightly backup', role: 'viewer', expires: '30', scopes: ['links:read', 'forms:read'] }));
    expect(keys()).toHaveLength(1);
    expect(keys()[0]).toMatchObject({ name: 'Nightly backup', kind: 'personal', role: 'viewer', service_account_id: null });
    expect(JSON.parse(keys()[0]!.scopes).sort()).toEqual(['forms:read', 'links:read']);
    expect(auditRows(t, 'api_key.created')).toHaveLength(1);
    expect(auditRows(t)).toHaveLength(1);
  });

  it('makes a full access key and a key that never expires', async () => {
    const who = await signIn();
    const res = await send(who, `${BASE}/new`, await keyForm(who, { expires: 'never', scopes: ['*'], role: 'admin' }));
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Full access');
    expect(html).toContain('Never');
    expect(JSON.parse(keys()[0]!.scopes)).toEqual(['*']);
  });

  it('makes a key for a service account, acting with the account’s role', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'viewer' });
    const res = await send(who, `${BASE}/new`, await keyForm(who, { account: account.id, role: 'admin' }));
    expect(res.status).toBe(200);
    expect(keys()[0]).toMatchObject({ kind: 'service', service_account_id: account.id, role: 'viewer' });
    expect(await res.text()).toContain('Billing sync');
  });

  it('makes no second key when the form is sent again', async () => {
    const who = await signIn();
    const form = await keyForm(who);
    expect((await send(who, `${BASE}/new`, form)).status).toBe(200);

    const again = await send(who, `${BASE}/new`, form);
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(BASE);
    expect(await again.text()).not.toMatch(/Bearer ts_/);
    expect(keys()).toHaveLength(1);
    expect(auditRows(t, 'api_key.created')).toHaveLength(1);

    // The explanation arrives as a flash message on the list.
    const cookie = /^([^=]+=[^;]+)/.exec(again.headers.get('set-cookie') ?? '')?.[1];
    expect(cookie).toBeTruthy();
    const list = await (await app.request(BASE, { headers: { ...who.session.headers, cookie: `${who.session.headers.cookie}; ${cookie}` } }, t.env)).text();
    expect(list).toContain('no second key was made');
  });

  it('refuses a form without a valid one-time token and makes nothing', async () => {
    const who = await signIn();
    for (const token of ['', 'made-up', '1.too-short']) {
      const res = await send(who, `${BASE}/new`, await keyForm(who, { form_token: token }));
      expect(res.status, token).toBe(422);
      expect(await res.text()).toContain('That form has expired');
    }
    expect(keys()).toHaveLength(0);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['no permissions', { scopes: [] as string[] }],
    ['a permission no module declares', { scopes: ['links:read', 'links:destroy'] }],
    ['a permission made up by hand', { scopes: ['admin:everything'] }],
    ['an expiry that is not offered', { expires: '7' }],
    ['a name that is too long', { name: 'x'.repeat(81) }],
    ['a service account that does not exist', { account: 'sa_missing' }, 404],
  ])('refuses %s with the form again and no key', async (_label, change, status = 422) => {
    const who = await signIn();
    const form = await keyForm(who, { name: 'Kept name', ...change });
    const res = await send(who, `${BASE}/new`, form);
    const html = await res.text();
    expect(res.status).toBe(status);
    expect(keys()).toHaveLength(0);
    expect(auditRows(t)).toHaveLength(0);
    expect(html).toContain('Make key');
    // The form comes back with a new token, so fixing it and sending again works.
    const next = tokenOf(html);
    expect(next).not.toBe('');
    expect(next).not.toBe(form.form_token);
    expect(html).not.toMatch(/Bearer ts_/);
  });

  it('keeps what was typed when something is wrong', async () => {
    const who = await signIn();
    const html = await (await send(who, `${BASE}/new`, await keyForm(who, { name: 'Kept name', scopes: [] }))).text();
    expect(html).toContain('value="Kept name"');
    expect(html).toContain('role="alert"');
  });

  it('does not let an admin make an owner key, even by posting the value by hand', async () => {
    const who = await signIn('admin');
    const res = await send(who, `${BASE}/new`, await keyForm(who, { role: 'owner' }));
    expect(res.status).toBe(422);
    expect(keys()).toHaveLength(0);
    // The form only ever offers roles a key can have.
    const form = await (await get(who, `${BASE}/new`)).text();
    expect(form).not.toContain('value="owner"');
  });

  it('turns away a member and a viewer who post to it', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const who = await signIn(role);
      const res = await send(who, `${BASE}/new`, { form_token: 'x', name: 'Sneaky', role: 'admin', expires: 'never', scopes: ['*'] });
      expect(res.status, role).toBe(403);
    }
    expect(keys()).toHaveLength(0);
  });
});

describe('renaming a key', () => {
  it('changes only the name and writes one audit entry', async () => {
    const who = await signIn();
    const { key } = await make(who, { scopes: ['links:read', 'links:write'] });
    const res = await send(who, `${BASE}/${key.id}/rename`, { name: 'Renamed key' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/${key.id}`);
    expect(keys()[0]).toMatchObject({ name: 'Renamed key', role: key.role });
    expect(JSON.parse(keys()[0]!.scopes)).toEqual(['links:read', 'links:write']);
    expect(auditRows(t, 'api_key.renamed')).toHaveLength(1);
  });

  it('shows what is wrong with an empty name and changes nothing', async () => {
    const who = await signIn();
    const { key } = await make(who, { name: 'Original' });
    const res = await send(who, `${BASE}/${key.id}/rename`, { name: '   ' });
    expect(res.status).toBe(422);
    expect(keys()[0]!.name).toBe('Original');
    expect(await res.text()).toContain('role="alert"');
    expect(auditRows(t, 'api_key.renamed')).toHaveLength(0);
  });

  it('cannot rename another workspace’s key', async () => {
    const who = await signIn();
    const theirs = await createApiKey(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Theirs', scopes: ['links:read'] });
    expect((await send(who, `${BASE}/${theirs.key.id}/rename`, { name: 'Taken over' })).status).toBe(404);
    expect(keys()[0]!.name).toBe('Theirs');
  });
});

describe('revoking a key', () => {
  it('stops the key right away and writes one audit entry', async () => {
    const who = await signIn();
    const { key, secret } = await make(who);
    expect(await verifyApiKey(t.env, secret)).not.toBeNull();

    const res = await send(who, `${BASE}/${key.id}/revoke`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(BASE);
    expect(await verifyApiKey(t.env, secret)).toBeNull();
    expect(keys()[0]!.revoked_at).not.toBeNull();
    expect(auditRows(t, 'api_key.revoked')).toHaveLength(1);
    expect(auditRows(t)).toHaveLength(2);

    const detail = await (await get(who, `${BASE}/${key.id}`)).text();
    expect(detail).toContain('This key is revoked');
    expect(detail).not.toContain('Revoke key');
  });

  it('cannot revoke or look at another workspace’s key', async () => {
    const who = await signIn();
    const theirs = await createApiKey(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Theirs', scopes: ['links:read'] });
    expect((await send(who, `${BASE}/${theirs.key.id}/revoke`)).status).toBe(404);
    expect((await get(who, `${BASE}/${theirs.key.id}`)).status).toBe(404);
    expect(keys()[0]!.revoked_at).toBeNull();
    expect(await verifyApiKey(t.env, theirs.secret)).not.toBeNull();
    expect(auditRows(t, 'api_key.revoked')).toHaveLength(0);
  });

  it('answers not found for an id that does not exist', async () => {
    const who = await signIn();
    expect((await send(who, `${BASE}/key_missing/revoke`)).status).toBe(404);
    expect((await get(who, `${BASE}/key_missing`)).status).toBe(404);
  });
});

describe('rotating a key', () => {
  it('stops the old secret at once and shows the new one once', async () => {
    const who = await signIn();
    const { key, secret } = await make(who, { name: 'Rotating key' });
    const res = await send(who, `${BASE}/${key.id}/rotate`, { grace: '0' });
    const html = await res.text();
    const fresh = secretOf(html);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(fresh).not.toBe('');
    expect(fresh).not.toBe(secret);
    expect(html).toContain('Copy your new key now');
    expect(html).toContain('The old key stopped working as soon as you rotated it');
    expect(await verifyApiKey(t.env, secret)).toBeNull();
    expect(await verifyApiKey(t.env, fresh)).not.toBeNull();
    expect(keys()).toHaveLength(2);
    expect(auditRows(t, 'api_key.rotated')).toHaveLength(1);

    for (const path of [BASE, `${BASE}?revoked=1`, `${BASE}/${key.id}`, `${BASE}/${keys()[1]!.id}`]) {
      expect(await (await get(who, path)).text(), path).not.toContain(fresh);
    }
  });

  it('keeps the old secret working for the time that was picked, then says when it stops', async () => {
    const who = await signIn();
    const { key, secret } = await make(who);
    const res = await send(who, `${BASE}/${key.id}/rotate`, { grace: '3600' });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toMatch(/The old key keeps working until .+, then stops\./);
    expect(await verifyApiKey(t.env, secret)).not.toBeNull();
    expect(await verifyApiKey(t.env, secretOf(html))).not.toBeNull();
    expect(await verifyApiKey(t.env, secret, Date.now() + 2 * 60 * 60 * 1000)).toBeNull();
  });

  it('makes no third key when the post is sent again', async () => {
    const who = await signIn();
    const { key } = await make(who);
    expect((await send(who, `${BASE}/${key.id}/rotate`, { grace: '86400' })).status).toBe(200);
    const again = await send(who, `${BASE}/${key.id}/rotate`, { grace: '86400' });
    expect(again.status).toBe(303);
    expect(again.headers.get('location')).toBe(`${BASE}/${key.id}`);
    expect(keys()).toHaveLength(2);
    expect(auditRows(t, 'api_key.rotated')).toHaveLength(1);
  });

  it.each([['99'], [''], ['-1'], ['forever']])('refuses a grace time of %j and rotates nothing', async (grace) => {
    const who = await signIn();
    const { key, secret } = await make(who);
    const res = await send(who, `${BASE}/${key.id}/rotate`, grace === '' ? {} : { grace });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}/${key.id}`);
    expect(keys()).toHaveLength(1);
    expect(await verifyApiKey(t.env, secret)).not.toBeNull();
  });

  it('refuses a revoked key', async () => {
    const who = await signIn();
    const { key } = await make(who);
    await send(who, `${BASE}/${key.id}/revoke`);
    const res = await send(who, `${BASE}/${key.id}/rotate`, { grace: '0' });
    expect(res.status).toBe(303);
    expect(keys()).toHaveLength(1);
  });

  it('lets only the owner of a personal key rotate it', async () => {
    const who = await signIn();
    const theirs = await createApiKey(t.env, actor('member', 'usr_other', ORG), { name: 'Their key', scopes: ['links:read'] });
    const detail = await (await get(who, `${BASE}/${theirs.key.id}`)).text();
    expect(detail).toContain('Only its owner can rotate it');
    expect(detail).not.toContain('Rotate the secret');

    expect((await send(who, `${BASE}/${theirs.key.id}/rotate`, { grace: '0' })).status).toBe(403);
    expect(keys()).toHaveLength(1);
    expect(await verifyApiKey(t.env, theirs.secret)).not.toBeNull();
  });

  it('can rotate a key of a service account', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    const { key } = await make(who, { serviceAccountId: account.id });
    expect((await send(who, `${BASE}/${key.id}/rotate`, { grace: '0' })).status).toBe(200);
    expect(keys()[1]).toMatchObject({ kind: 'service', service_account_id: account.id });
  });

  it('cannot rotate another workspace’s key', async () => {
    const who = await signIn();
    const theirs = await createApiKey(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Theirs', scopes: ['links:read'] });
    expect((await send(who, `${BASE}/${theirs.key.id}/rotate`, { grace: '0' })).status).toBe(404);
    expect(keys()).toHaveLength(1);
    expect(await verifyApiKey(t.env, theirs.secret)).not.toBeNull();
  });
});

describe('service accounts', () => {
  it('makes one, with one audit entry, and opens its page', async () => {
    const who = await signIn();
    const res = await send(who, `${BASE}/accounts/new`, { name: 'Billing sync', role: 'viewer' });
    expect(res.status).toBe(303);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]).toMatchObject({ name: 'Billing sync', role: 'viewer' });
    expect(res.headers.get('location')).toBe(`${BASE}/accounts/${accounts()[0]!.id}`);
    expect(auditRows(t, 'service_account.created')).toHaveLength(1);

    const page = await (await get(who, res.headers.get('location')!)).text();
    expect(page).toContain('Billing sync');
    expect(page).toContain('No working keys');
  });

  it.each([
    ['an empty name', { name: '', role: 'member' }],
    ['an owner role', { name: 'Sync', role: 'owner' }],
    ['an unknown role', { name: 'Sync', role: 'superuser' }],
    ['a name that is too long', { name: 'x'.repeat(81), role: 'member' }],
  ])('refuses %s and keeps the form', async (_label, fields) => {
    const who = await signIn();
    const res = await send(who, `${BASE}/accounts/new`, fields);
    expect(res.status).toBe(422);
    expect(accounts()).toHaveLength(0);
    expect(await res.text()).toContain('Make service account');
  });

  it('refuses a name that is already taken', async () => {
    const who = await signIn();
    await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    const res = await send(who, `${BASE}/accounts/new`, { name: 'Billing sync', role: 'member' });
    expect(res.status).toBe(409);
    expect(accounts()).toHaveLength(1);
    expect(await res.text()).toContain('value="Billing sync"');
  });

  it('renames one and changes its role, with one audit entry', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    const res = await send(who, `${BASE}/accounts/${account.id}`, { name: 'Invoice sync', role: 'viewer' });
    expect(res.status).toBe(303);
    expect(accounts()[0]).toMatchObject({ name: 'Invoice sync', role: 'viewer' });
    expect(auditRows(t, 'service_account.updated')).toHaveLength(1);
  });

  it('refuses an empty name on a saved account and changes nothing', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    const res = await send(who, `${BASE}/accounts/${account.id}`, { name: '', role: 'member' });
    expect(res.status).toBe(422);
    expect(accounts()[0]!.name).toBe('Billing sync');
    expect(auditRows(t, 'service_account.updated')).toHaveLength(0);
  });

  it('lists the keys that work on its page and warns what deleting does', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    await make(who, { name: 'Sync key one', serviceAccountId: account.id });
    await make(who, { name: 'Sync key two', serviceAccountId: account.id });
    await make(who, { name: 'Someone else’s key' });
    const page = await (await get(who, `${BASE}/accounts/${account.id}`)).text();
    expect(page).toContain('Sync key one');
    expect(page).toContain('Sync key two');
    expect(page).not.toContain('Someone else’s key');
    expect(page).toContain('2 working keys will be revoked');
  });

  it('deletes one and revokes its keys, with one audit entry for each', async () => {
    const who = await signIn();
    const account = await createServiceAccount(t.env, who.actor, { name: 'Billing sync', role: 'member' });
    const a = await make(who, { name: 'Sync key one', serviceAccountId: account.id });
    const b = await make(who, { name: 'Sync key two', serviceAccountId: account.id });
    const other = await make(who, { name: 'Personal key' });

    const res = await send(who, `${BASE}/accounts/${account.id}/delete`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}?tab=accounts`);
    expect(accounts()[0]!.deleted_at).not.toBeNull();
    expect(await verifyApiKey(t.env, a.secret)).toBeNull();
    expect(await verifyApiKey(t.env, b.secret)).toBeNull();
    expect(await verifyApiKey(t.env, other.secret)).not.toBeNull();
    expect(auditRows(t, 'service_account.deleted')).toHaveLength(1);
    expect(auditRows(t, 'api_key.revoked')).toHaveLength(0);

    const cookie = /^([^=]+=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1];
    const list = await (await app.request(`${BASE}?tab=accounts`, { headers: { ...who.session.headers, cookie: `${who.session.headers.cookie}; ${cookie}` } }, t.env)).text();
    expect(list).toContain('2 keys were revoked');
  });

  it('cannot see, change or delete another workspace’s account', async () => {
    const who = await signIn();
    const theirs = await createServiceAccount(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Theirs', role: 'member' });
    const key = await createApiKey(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Their key', scopes: ['links:read'], serviceAccountId: theirs.id });

    expect((await get(who, `${BASE}/accounts/${theirs.id}`)).status).toBe(404);
    expect((await send(who, `${BASE}/accounts/${theirs.id}`, { name: 'Mine now', role: 'admin' })).status).toBe(404);
    expect((await send(who, `${BASE}/accounts/${theirs.id}/delete`)).status).toBe(404);
    expect(accounts()[0]).toMatchObject({ name: 'Theirs', role: 'member' });
    expect(await verifyApiKey(t.env, key.secret)).not.toBeNull();
  });

  it('turns away a member who posts to it', async () => {
    const who = await signIn('member');
    expect((await send(who, `${BASE}/accounts/new`, { name: 'Sneaky', role: 'admin' })).status).toBe(403);
    expect(accounts()).toHaveLength(0);
  });
});

describe('the signing key', () => {
  const panel = 'Signing key';

  it('is shown to the person who owns the install, with the key list URL', async () => {
    const who = await signIn('owner', { instanceOwner: true });
    await rotateSigningKey(t.env);
    const status = (await getSigningKeyStatus(t.env))!;
    const html = await (await get(who, BASE)).text();
    expect(html).toContain(panel);
    expect(html).toContain(status.kid);
    expect(html).toContain('http://localhost/.well-known/jwks.json');
    expect(html).toContain('Rotate now');
  });

  it('is not shown to a workspace owner who does not own the install', async () => {
    const who = await signIn('owner');
    await rotateSigningKey(t.env);
    const html = await (await get(who, BASE)).text();
    expect(html).not.toContain(panel);
    expect(html).not.toContain('Rotate now');
    expect(html).not.toContain((await getSigningKeyStatus(t.env))!.kid);
  });

  it('refuses a workspace owner who does not own the install, and changes nothing', async () => {
    const who = await signIn('owner');
    await rotateSigningKey(t.env);
    const before = await getSigningKeyStatus(t.env);
    const rowsBefore = tableRows(t, 'jwt_signing_keys');
    const auditBefore = auditRows(t, 'signing_key.rotated').length;

    const res = await send(who, `${BASE}/signing-key/rotate`);
    expect(res.status).toBe(403);
    expect(await getSigningKeyStatus(t.env)).toEqual(before);
    expect(tableRows(t, 'jwt_signing_keys')).toEqual(rowsBefore);
    expect(auditRows(t, 'signing_key.rotated')).toHaveLength(auditBefore);
  });

  it('is out of reach of a member, even one who owns the install', async () => {
    const who = await signIn('member', { instanceOwner: true });
    await rotateSigningKey(t.env);
    const before = await getSigningKeyStatus(t.env);
    expect((await send(who, `${BASE}/signing-key/rotate`)).status).toBe(403);
    expect(await getSigningKeyStatus(t.env)).toEqual(before);
  });

  it('is replaced by the person who owns the install, with one audit entry', async () => {
    const who = await signIn('owner', { instanceOwner: true });
    await rotateSigningKey(t.env);
    const before = (await getSigningKeyStatus(t.env))!;
    const auditBefore = auditRows(t, 'signing_key.rotated').length;

    const res = await send(who, `${BASE}/signing-key/rotate`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(BASE);
    const after = (await getSigningKeyStatus(t.env))!;
    expect(after.kid).not.toBe(before.kid);
    const rows = auditRows(t, 'signing_key.rotated');
    expect(rows).toHaveLength(auditBefore + 1);
    expect(rows.at(-1)).toMatchObject({ actor_id: who.session.user.id, actor_type: 'user' });
  });

  it('shows that no key exists yet', async () => {
    const who = await signIn('owner', { instanceOwner: true });
    const html = await (await get(who, BASE)).text();
    expect(html).toContain('No signing key yet');
  });
});
