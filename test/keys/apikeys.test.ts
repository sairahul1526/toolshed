import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createApiKey,
  generateKey,
  getApiKey,
  LAST_USED_INTERVAL_MS,
  limitKeysForUser,
  listApiKeys,
  listScopes,
  MAX_ACTIVE_KEYS,
  renameApiKey,
  revokeApiKey,
  revokeKeysForUser,
  rotateApiKey,
  touchApiKey,
  verifyApiKey,
} from '../../src/core/apikeys';
import type { CreateKeyInput, KeyActor } from '../../src/core/apikeys';
import { base62Fixed, crc32, randomBase62 } from '../../src/core/keys/encoding';
import { registerModules } from '../../src/core/registry';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { actor, auditRows, coldInstance, DAY, failure, MINUTE, ORG_A, ORG_B, SECOND, T0, tableRows, useModules } from './helpers';

interface StoredKey {
  id: string;
  org_id: string;
  prefix: string;
  key_hash: string;
  role: string;
  revoked_at: number | null;
  revoked_reason: string | null;
  replaced_by: string | null;
  last_used_at: number | null;
  last_used_ip: string | null;
}

let t: TestEnv;
const owner = actor('owner');
const admin = actor('admin');
const member = actor('member');
const viewer = actor('viewer');

beforeEach(() => {
  t = createTestEnv();
  useModules();
});
afterEach(() => registerModules([]));

const make = (who: KeyActor, input: Partial<CreateKeyInput> = {}, now = T0) =>
  createApiKey(t.env, who, { name: 'Deploy script', scopes: ['links:read'], ...input }, now);

/** A key with a real key id and a correct checksum, but a secret nobody was ever given. */
function forge(prefix: string): string {
  const body = prefix + randomBase62(32);
  return body + base62Fixed(crc32(body), 6);
}

describe('createApiKey', () => {
  it('returns the secret once and stores only its hash', async () => {
    const { key, secret } = await make(admin);
    expect(secret).toMatch(/^ts_test_[0-9A-Za-z]{46}$/);
    expect(key).toMatchObject({ name: 'Deploy script', kind: 'personal', prefix: secret.slice(0, 16), scopes: ['links:read'], role: 'admin', userId: admin.userId, status: 'active', createdAt: T0, expiresAt: null, lastUsedAt: null });
    expect(key.id).toMatch(/^key_/);

    const [row] = tableRows<StoredKey>(t, 'api_keys');
    expect(row!.key_hash).toBe(createHash('sha256').update(secret).digest('hex'));
    const everythingStored = JSON.stringify([tableRows(t, 'api_keys'), auditRows(t)]);
    expect(everythingStored).not.toContain(secret);
    expect(everythingStored).not.toContain(secret.slice(16, 48));
    expect(JSON.stringify(key)).not.toContain(row!.key_hash);
    expect(Object.keys(key)).not.toContain('secret');
  });

  it('makes live keys outside dev and test installs', async () => {
    const live = createTestEnv({ ENVIRONMENT: 'production' });
    const { secret } = await createApiKey(live.env, admin, { name: 'Live', scopes: ['*'] }, T0);
    expect(secret).toMatch(/^ts_live_/);
  });

  it('gives the creator’s role by default, and Admin to the owner', async () => {
    expect((await make(owner)).key.role).toBe('admin');
    expect((await make(member)).key.role).toBe('member');
    expect((await make(viewer)).key.role).toBe('viewer');
  });

  it('never makes a key stronger than its creator', async () => {
    expect((await failure(() => make(member, { role: 'admin' }))).code).toBe('keys.role_too_high');
    expect((await failure(() => make(viewer, { role: 'member' }))).code).toBe('keys.role_too_high');
    expect((await make(member, { role: 'viewer' })).key.role).toBe('viewer');
    expect((await make(owner, { role: 'admin' })).key.role).toBe('admin');
    expect(tableRows(t, 'api_keys')).toHaveLength(2);
  });

  it('never makes an owner key', async () => {
    const err = await failure(() => make(owner, { role: 'owner' as never }));
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toHaveProperty('role');
  });

  it('checks scopes against what modules declare', async () => {
    const unknown = await failure(() => make(admin, { scopes: ['links:read', 'nope:read', 'links:delete'] }));
    expect(unknown.code).toBe('keys.unknown_scope');
    expect(unknown.status).toBe(422);
    expect(unknown.fields?.scopes).toContain('nope:read');
    expect(unknown.fields?.scopes).toContain('links:delete');

    expect((await make(admin, { scopes: ['links:write', 'forms:read', 'links:write'] })).key.scopes).toEqual(['forms:read', 'links:write']);
    expect((await make(admin, { scopes: ['links:*'] })).key.scopes).toEqual(['links:*']);
    expect((await make(admin, { scopes: ['links:read', '*'] })).key.scopes).toEqual(['*']);
    expect((await failure(() => make(admin, { scopes: [] }))).fields).toHaveProperty('scopes');
    expect((await failure(() => make(admin, { scopes: ['unknown:*'] }))).code).toBe('keys.unknown_scope');
  });

  it('lists the scopes modules declare', () => {
    expect(listScopes()).toEqual([
      { module: 'forms', scope: 'forms:read', label: 'See forms and answers' },
      { module: 'links', scope: 'links:read', label: 'See links' },
      { module: 'links', scope: 'links:write', label: 'Create, edit and delete links' },
    ]);
  });

  it('sets an expiry from a number of days', async () => {
    expect((await make(admin, { expiresInDays: 30 })).key.expiresAt).toBe(T0 + 30 * DAY);
    expect((await make(admin, { expiresInDays: null })).key.expiresAt).toBeNull();
    for (const bad of [0, -1, 1.5, 4000, '30' as never]) {
      expect((await failure(() => make(admin, { expiresInDays: bad }))).fields, String(bad)).toHaveProperty('expiresInDays');
    }
  });

  it('refuses a misspelt field instead of quietly making a key that never expires', async () => {
    const err = await failure(() => make(admin, { expiresInDay: 30 } as never));
    expect(err.code).toBe('validation_failed');
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
  });

  it('needs a sensible name', async () => {
    for (const name of ['', '   ', 'x'.repeat(81), 'two\nlines']) {
      expect((await failure(() => make(admin, { name }))).fields, JSON.stringify(name)).toHaveProperty('name');
    }
    expect((await make(admin, { name: '  CI  ' })).key.name).toBe('CI');
  });

  it('stops at the workspace limit', async () => {
    const insert = t.sqlite.prepare(
      `INSERT INTO api_keys (id, org_id, name, kind, user_id, prefix, key_hash, scopes, role, created_by, created_at)
       VALUES (?, ?, 'Filler', 'personal', 'usr_x', ?, 'x', '["*"]', 'viewer', 'usr_x', ?)`,
    );
    for (let i = 0; i < MAX_ACTIVE_KEYS; i++) insert.run(`key_fill_${i}`, ORG_A, `ts_test_fill${String(i).padStart(4, '0')}`, T0);
    expect((await failure(() => make(admin))).code).toBe('keys.too_many');
    // Another workspace has its own count.
    expect((await make(actor('admin', 'usr_b', ORG_B))).key.id).toBeTruthy();
  });

  it('writes an audit entry', async () => {
    const { key } = await make(admin, { expiresInDays: 7 });
    const [entry] = auditRows(t, 'api_key.created');
    expect(entry).toMatchObject({ org_id: ORG_A, actor_id: admin.userId, actor_type: 'user', actor_label: admin.label, target_type: 'api_key', target_id: key.id, ip: '203.0.113.7' });
    expect(entry!.summary).toBe('Created the key Deploy script as Admin');
    expect(JSON.parse(entry!.meta!)).toMatchObject({ prefix: key.prefix, role: 'admin', scopes: ['links:read'], expiresAt: T0 + 7 * DAY });
  });
});

describe('only a signed-in person changes keys', () => {
  it('refuses every change made with a key or a token', async () => {
    const { key } = await make(admin);
    for (const via of ['apikey', 'jwt'] as const) {
      const caller = { ...admin, via };
      for (const attempt of [
        () => make(caller),
        () => renameApiKey(t.env, caller, key.id, 'New name', T0),
        () => revokeApiKey(t.env, caller, key.id, T0),
        () => rotateApiKey(t.env, caller, key.id, {}, T0),
      ]) {
        const err = await failure(attempt);
        expect(err.code).toBe('keys.session_required');
        expect(err.status).toBe(403);
      }
    }
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
    expect((await getApiKey(t.env, admin, key.id, T0)).status).toBe('active');
  });

  it('treats an actor with no `via` as not a session, so a caller that forgets it cannot make keys', async () => {
    const { via: _via, ...unknown } = admin;
    const err = await failure(() => make(unknown as KeyActor));
    expect(err.code).toBe('keys.session_required');
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
  });
});

describe('verifyApiKey', () => {
  it('accepts a live key and says what it may do', async () => {
    const { key, secret } = await make(member, { scopes: ['links:write'], expiresInDays: 1 });
    expect(await verifyApiKey(t.env, secret, T0 + SECOND)).toEqual({
      orgId: ORG_A,
      keyId: key.id,
      name: 'Deploy script',
      scopes: ['links:write'],
      role: 'member',
      kind: 'personal',
      userId: member.userId,
      serviceAccountId: null,
      serviceAccountName: null,
      prefix: key.prefix,
      lastUsedAt: null,
    });
  });

  it('refuses garbage and mistyped keys without asking the database', async () => {
    const { secret } = await make(admin);
    const cold = coldInstance(t.env);
    const typo = secret.slice(0, 30) + (secret[30] === 'A' ? 'B' : 'A') + secret.slice(31);
    for (const bad of ['', 'garbage', 'Bearer x', secret.slice(0, -2), typo, 'x'.repeat(10_000)]) {
      expect(await verifyApiKey(cold.env, bad, T0)).toBeNull();
    }
    expect(cold.queries()).toBe(0);
  });

  it('makes exactly one database read for a well-formed key, real or not', async () => {
    const { secret } = await make(admin);
    const cold = coldInstance(t.env);
    expect(await verifyApiKey(cold.env, secret, T0)).not.toBeNull();
    expect(cold.queries()).toBe(1);
    expect(await verifyApiKey(cold.env, generateKey('test').secret, T0)).toBeNull();
    expect(cold.queries()).toBe(2);
  });

  it('refuses the right key id with the wrong secret', async () => {
    const { key } = await make(admin);
    expect(await verifyApiKey(t.env, forge(key.prefix), T0)).toBeNull();
  });

  it('refuses a revoked key on the very next call', async () => {
    const { key, secret } = await make(admin);
    expect(await verifyApiKey(t.env, secret, T0)).not.toBeNull();
    await revokeApiKey(t.env, admin, key.id, T0 + SECOND);
    expect(await verifyApiKey(t.env, secret, T0 + SECOND)).toBeNull();
  });

  it('refuses an expired key from the moment it expires', async () => {
    const { secret } = await make(admin, { expiresInDays: 1 });
    expect(await verifyApiKey(t.env, secret, T0 + DAY - 1)).not.toBeNull();
    expect(await verifyApiKey(t.env, secret, T0 + DAY)).toBeNull();
    expect(await verifyApiKey(t.env, secret, T0 + 2 * DAY)).toBeNull();
  });

  it('refuses a key whose stored hash is damaged', async () => {
    const { secret } = await make(admin);
    t.sqlite.exec("UPDATE api_keys SET key_hash = 'not-hex'");
    expect(await verifyApiKey(t.env, secret, T0)).toBeNull();
    t.sqlite.exec("UPDATE api_keys SET key_hash = ''");
    expect(await verifyApiKey(t.env, secret, T0)).toBeNull();
  });

  it('falls back to the weakest role and no scopes when a row is unreadable', async () => {
    const { secret } = await make(admin);
    t.sqlite.exec("UPDATE api_keys SET role = 'owner', scopes = 'not json'");
    expect(await verifyApiKey(t.env, secret, T0)).toMatchObject({ role: 'viewer', scopes: [] });
  });
});

describe('last used', () => {
  it('is written at most once a minute per key', async () => {
    const { secret } = await make(admin);
    const first = (await verifyApiKey(t.env, secret, T0))!;
    expect(await touchApiKey(t.env, first, { ip: '198.51.100.4', now: T0 })).toBe(true);
    expect(tableRows<StoredKey>(t, 'api_keys')[0]).toMatchObject({ last_used_at: T0, last_used_ip: '198.51.100.4' });

    const soon = (await verifyApiKey(t.env, secret, T0 + 30 * SECOND))!;
    expect(soon.lastUsedAt).toBe(T0);
    const cold = coldInstance(t.env);
    expect(await touchApiKey(cold.env, soon, { ip: '198.51.100.9', now: T0 + 30 * SECOND })).toBe(false);
    expect(cold.queries()).toBe(0);
    expect(tableRows<StoredKey>(t, 'api_keys')[0]).toMatchObject({ last_used_at: T0, last_used_ip: '198.51.100.4' });

    const later = (await verifyApiKey(t.env, secret, T0 + LAST_USED_INTERVAL_MS))!;
    expect(await touchApiKey(t.env, later, { ip: '198.51.100.9', now: T0 + LAST_USED_INTERVAL_MS })).toBe(true);
    expect(tableRows<StoredKey>(t, 'api_keys')[0]).toMatchObject({ last_used_at: T0 + MINUTE, last_used_ip: '198.51.100.9' });
  });

  it('lets only one of several racing requests write', async () => {
    const { secret } = await make(admin);
    const seen = (await verifyApiKey(t.env, secret, T0))!;
    const wrote = await Promise.all([1, 2, 3].map(() => touchApiKey(t.env, seen, { now: T0 })));
    expect(wrote.filter(Boolean)).toHaveLength(1);
  });

  it('shows in the list', async () => {
    const { key, secret } = await make(admin);
    await touchApiKey(t.env, (await verifyApiKey(t.env, secret, T0))!, { ip: '198.51.100.4', now: T0 + SECOND });
    expect(await getApiKey(t.env, admin, key.id, T0 + MINUTE)).toMatchObject({ lastUsedAt: T0 + SECOND, lastUsedIp: '198.51.100.4' });
  });
});

describe('listApiKeys and getApiKey', () => {
  it('shows admins every key and everyone else only their own', async () => {
    const mine = await make(member, { name: 'Mine' }, T0);
    const theirs = await make(admin, { name: 'Theirs' }, T0 + 1);
    const other = await make(actor('member', 'usr_other'), { name: 'Other' }, T0 + 2);

    expect((await listApiKeys(t.env, admin, {}, T0 + 3)).map((k) => k.name)).toEqual(['Other', 'Theirs', 'Mine']);
    expect((await listApiKeys(t.env, owner, {}, T0 + 3)).map((k) => k.name)).toEqual(['Other', 'Theirs', 'Mine']);
    expect((await listApiKeys(t.env, member, {}, T0 + 3)).map((k) => k.name)).toEqual(['Mine']);
    expect(await listApiKeys(t.env, viewer, {}, T0 + 3)).toEqual([]);

    expect((await getApiKey(t.env, member, mine.key.id, T0)).name).toBe('Mine');
    expect((await failure(() => getApiKey(t.env, member, theirs.key.id, T0))).code).toBe('not_found');
    expect((await failure(() => getApiKey(t.env, member, other.key.id, T0))).code).toBe('not_found');
    expect((await failure(() => getApiKey(t.env, admin, 'key_missing', T0))).code).toBe('not_found');
  });

  it('never returns a secret or a hash', async () => {
    const a = await make(admin);
    const b = await make(member);
    const listed = JSON.stringify([await listApiKeys(t.env, admin, { includeRevoked: true }, T0), await getApiKey(t.env, admin, a.key.id, T0)]);
    for (const row of tableRows<StoredKey>(t, 'api_keys')) expect(listed).not.toContain(row.key_hash);
    for (const secret of [a.secret, b.secret]) {
      expect(listed).not.toContain(secret);
      expect(listed).not.toContain(secret.slice(16, 48));
    }
    expect(listed).not.toMatch(/key_hash|keyHash|secret/);
  });

  it('leaves revoked keys out unless asked, and marks expired ones', async () => {
    const gone = await make(admin, { name: 'Gone' }, T0);
    await make(admin, { name: 'Short', expiresInDays: 1 }, T0 + 1);
    await revokeApiKey(t.env, admin, gone.key.id, T0 + 2);
    const live = await listApiKeys(t.env, admin, {}, T0 + 2 * DAY);
    expect(live.map((k) => [k.name, k.status])).toEqual([['Short', 'expired']]);
    const all = await listApiKeys(t.env, admin, { includeRevoked: true }, T0 + 2 * DAY);
    expect(all.map((k) => [k.name, k.status])).toEqual([
      ['Short', 'expired'],
      ['Gone', 'revoked'],
    ]);
  });
});

describe('renameApiKey', () => {
  it('renames and writes an audit entry', async () => {
    const { key, secret } = await make(member);
    expect((await renameApiKey(t.env, member, key.id, '  Renamed ', T0)).name).toBe('Renamed');
    expect((await verifyApiKey(t.env, secret, T0))!.name).toBe('Renamed');
    expect(auditRows(t, 'api_key.renamed')[0]).toMatchObject({ actor_id: member.userId, target_id: key.id, summary: 'Renamed the key Deploy script to Renamed' });
    // The same name again changes nothing and logs nothing.
    await renameApiKey(t.env, member, key.id, 'Renamed', T0);
    expect(auditRows(t, 'api_key.renamed')).toHaveLength(1);
  });

  it('refuses a bad name, a revoked key and someone else’s key', async () => {
    const { key } = await make(admin);
    expect((await failure(() => renameApiKey(t.env, admin, key.id, '', T0))).fields).toHaveProperty('name');
    expect((await failure(() => renameApiKey(t.env, member, key.id, 'Stolen', T0))).code).toBe('not_found');
    await revokeApiKey(t.env, admin, key.id, T0);
    expect((await failure(() => renameApiKey(t.env, admin, key.id, 'Late', T0))).code).toBe('keys.revoked');
  });
});

describe('revokeApiKey', () => {
  it('lets a member revoke their own key and an admin revoke anyone’s', async () => {
    const mine = await make(member);
    const other = await make(actor('member', 'usr_other'));
    expect((await failure(() => revokeApiKey(t.env, member, other.key.id, T0))).code).toBe('not_found');
    expect(await revokeApiKey(t.env, member, mine.key.id, T0 + 5)).toMatchObject({ status: 'revoked', revokedAt: T0 + 5 });
    expect((await revokeApiKey(t.env, admin, other.key.id, T0 + 6)).status).toBe('revoked');
    expect(await verifyApiKey(t.env, mine.secret, T0 + 7)).toBeNull();
    expect(await verifyApiKey(t.env, other.secret, T0 + 7)).toBeNull();
    expect(tableRows<StoredKey>(t, 'api_keys').map((r) => r.revoked_reason)).toEqual(['manual', 'manual']);
  });

  it('does nothing the second time', async () => {
    const { key } = await make(admin);
    await revokeApiKey(t.env, admin, key.id, T0 + 1);
    expect((await revokeApiKey(t.env, admin, key.id, T0 + 99)).revokedAt).toBe(T0 + 1);
    expect(auditRows(t, 'api_key.revoked')).toHaveLength(1);
    expect(auditRows(t, 'api_key.revoked')[0]).toMatchObject({ target_id: key.id, summary: 'Revoked the key Deploy script' });
  });
});

describe('rotateApiKey', () => {
  it('swaps the secret and stops the old key at once', async () => {
    const old = await make(member, { scopes: ['links:write'], expiresInDays: 90 }, T0);
    const at = T0 + 10 * DAY;
    const rotated = await rotateApiKey(t.env, member, old.key.id, {}, at);

    expect(rotated.secret).not.toBe(old.secret);
    expect(rotated.key).toMatchObject({ name: 'Deploy script', scopes: ['links:write'], role: 'member', userId: member.userId, kind: 'personal', rotatedFrom: old.key.id, createdAt: at, expiresAt: at + 90 * DAY, status: 'active' });
    expect(rotated.key.id).not.toBe(old.key.id);
    expect(rotated.previous).toMatchObject({ id: old.key.id, status: 'revoked', revokedAt: at, replacedBy: rotated.key.id });

    expect(await verifyApiKey(t.env, old.secret, at)).toBeNull();
    expect((await verifyApiKey(t.env, rotated.secret, at))!.keyId).toBe(rotated.key.id);
    expect(tableRows<StoredKey>(t, 'api_keys').find((r) => r.id === old.key.id)).toMatchObject({ revoked_reason: 'rotated', replaced_by: rotated.key.id });

    const [entry] = auditRows(t, 'api_key.rotated');
    expect(entry).toMatchObject({ actor_id: member.userId, target_id: old.key.id, summary: 'Rotated the key Deploy script. The old key stopped working' });
    expect(JSON.stringify(auditRows(t))).not.toContain(rotated.secret.slice(16, 48));
  });

  it('can leave the old key working for a grace time', async () => {
    const old = await make(admin, {}, T0);
    const rotated = await rotateApiKey(t.env, admin, old.key.id, { graceSeconds: 3600 }, T0 + DAY);
    expect(rotated.previous).toMatchObject({ status: 'active', expiresAt: T0 + DAY + 3600 * SECOND, replacedBy: rotated.key.id });
    expect(rotated.key.expiresAt).toBeNull();
    expect(await verifyApiKey(t.env, old.secret, T0 + DAY + 3599 * SECOND)).not.toBeNull();
    expect(await verifyApiKey(t.env, old.secret, T0 + DAY + 3600 * SECOND)).toBeNull();
    expect(await verifyApiKey(t.env, rotated.secret, T0 + 30 * DAY)).not.toBeNull();
    // The old key was already replaced. Rotating it again would fork the chain.
    expect((await failure(() => rotateApiKey(t.env, admin, old.key.id, {}, T0 + DAY + 1))).code).toBe('keys.already_rotated');
  });

  it('never lengthens the old key’s life with a grace time', async () => {
    const old = await make(admin, { expiresInDays: 1 }, T0);
    const rotated = await rotateApiKey(t.env, admin, old.key.id, { graceSeconds: 7 * 24 * 3600 }, T0 + DAY - MINUTE);
    expect(rotated.previous.expiresAt).toBe(T0 + DAY);
  });

  it('checks the grace time', async () => {
    const { key } = await make(admin);
    for (const graceSeconds of [-1, 1.5, 7 * 24 * 3600 + 1]) {
      expect((await failure(() => rotateApiKey(t.env, admin, key.id, { graceSeconds }, T0))).fields).toHaveProperty('graceSeconds');
    }
    expect((await failure(() => rotateApiKey(t.env, admin, key.id, { grace: 60 } as never, T0))).code).toBe('validation_failed');
  });

  it('refuses a revoked or expired key', async () => {
    const gone = await make(admin);
    await revokeApiKey(t.env, admin, gone.key.id, T0);
    expect((await failure(() => rotateApiKey(t.env, admin, gone.key.id, {}, T0))).code).toBe('keys.revoked');
    const short = await make(admin, { expiresInDays: 1 });
    expect((await failure(() => rotateApiKey(t.env, admin, short.key.id, {}, T0 + DAY))).code).toBe('keys.expired');
  });

  it('is only for the member the key belongs to', async () => {
    const { key } = await make(member);
    const err = await failure(() => rotateApiKey(t.env, admin, key.id, {}, T0));
    expect(err.code).toBe('forbidden');
    expect((await failure(() => rotateApiKey(t.env, actor('member', 'usr_other'), key.id, {}, T0))).code).toBe('not_found');
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
  });

  it('gives the new key the weaker of the old role and the member’s role now', async () => {
    const { key } = await make(actor('admin', 'usr_demoted'));
    const rotated = await rotateApiKey(t.env, actor('member', 'usr_demoted'), key.id, {}, T0 + 1);
    expect(rotated.key.role).toBe('member');
    const viewerKey = await make(actor('member', 'usr_promoted'), { role: 'viewer' });
    expect((await rotateApiKey(t.env, actor('admin', 'usr_promoted'), viewerKey.key.id, {}, T0 + 1)).key.role).toBe('viewer');
  });

  it('lets only one of two rotations at the same moment win', async () => {
    const { key } = await make(admin);
    const results = await Promise.allSettled([rotateApiKey(t.env, admin, key.id, {}, T0 + 1), rotateApiKey(t.env, admin, key.id, {}, T0 + 1)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toMatchObject({ code: 'keys.already_rotated' });
    expect(tableRows(t, 'api_keys')).toHaveLength(2);
    expect(await listApiKeys(t.env, admin, {}, T0 + 2)).toHaveLength(1);
  });
});

describe('when a member leaves or changes role', () => {
  it('revokes their personal keys and nobody else’s', async () => {
    const leaver = actor('member', 'usr_leaver');
    const a = await make(leaver, { name: 'A' });
    const b = await make(leaver, { name: 'B' });
    const stays = await make(member);
    const sameUserElsewhere = await make(actor('member', 'usr_leaver', ORG_B));

    expect(await revokeKeysForUser(t.env, ORG_A, 'usr_leaver', T0 + 5)).toBe(2);
    expect(await verifyApiKey(t.env, a.secret, T0 + 5)).toBeNull();
    expect(await verifyApiKey(t.env, b.secret, T0 + 5)).toBeNull();
    expect(await verifyApiKey(t.env, stays.secret, T0 + 5)).not.toBeNull();
    expect(await verifyApiKey(t.env, sameUserElsewhere.secret, T0 + 5)).not.toBeNull();

    const [entry] = auditRows(t, 'api_key.revoked');
    expect(entry).toMatchObject({ org_id: ORG_A, actor_type: 'system', target_type: 'user', target_id: 'usr_leaver', summary: 'Revoked 2 keys because their owner left the workspace' });
    expect(await revokeKeysForUser(t.env, ORG_A, 'usr_leaver', T0 + 6)).toBe(0);
    expect(auditRows(t, 'api_key.revoked')).toHaveLength(1);
  });

  it('lowers keys that are stronger than a demoted member', async () => {
    const who = actor('admin', 'usr_demoted');
    const strong = await make(who, { role: 'admin' });
    const weak = await make(who, { role: 'viewer' });
    const bystander = await make(admin);

    expect(await limitKeysForUser(t.env, ORG_A, 'usr_demoted', 'member')).toBe(1);
    expect((await verifyApiKey(t.env, strong.secret, T0))!.role).toBe('member');
    expect((await verifyApiKey(t.env, weak.secret, T0))!.role).toBe('viewer');
    expect((await verifyApiKey(t.env, bystander.secret, T0))!.role).toBe('admin');
    expect(auditRows(t, 'api_key.role_lowered')[0]).toMatchObject({ actor_type: 'system', target_id: 'usr_demoted' });

    expect(await limitKeysForUser(t.env, ORG_A, 'usr_demoted', 'viewer')).toBe(1);
    expect((await verifyApiKey(t.env, strong.secret, T0))!.role).toBe('viewer');
    // A promotion never raises a key.
    expect(await limitKeysForUser(t.env, ORG_A, 'usr_demoted', 'owner')).toBe(0);
    expect((await verifyApiKey(t.env, strong.secret, T0))!.role).toBe('viewer');
  });
});

describe('workspaces are kept apart', () => {
  it('hides one workspace’s keys from another, whoever asks', async () => {
    const { key, secret } = await make(admin);
    const outsider = actor('owner', 'usr_outsider', ORG_B);
    // Same user id, other workspace: still not their key there.
    const sameUser = actor('admin', admin.userId, ORG_B);

    for (const who of [outsider, sameUser]) {
      expect(await listApiKeys(t.env, who, { includeRevoked: true }, T0)).toEqual([]);
      expect((await failure(() => getApiKey(t.env, who, key.id, T0))).code).toBe('not_found');
      expect((await failure(() => renameApiKey(t.env, who, key.id, 'Stolen', T0))).code).toBe('not_found');
      expect((await failure(() => revokeApiKey(t.env, who, key.id, T0))).code).toBe('not_found');
      expect((await failure(() => rotateApiKey(t.env, who, key.id, {}, T0))).code).toBe('not_found');
    }
    expect(await revokeKeysForUser(t.env, ORG_B, admin.userId, T0)).toBe(0);
    expect(await limitKeysForUser(t.env, ORG_B, admin.userId, 'viewer')).toBe(0);

    expect(await verifyApiKey(t.env, secret, T0)).toMatchObject({ orgId: ORG_A, keyId: key.id, name: 'Deploy script', role: 'admin' });
    expect(auditRows(t).every((r) => r.org_id === ORG_A)).toBe(true);
  });
});
