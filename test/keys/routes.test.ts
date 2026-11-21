import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyApiKey } from '../../src/core/apikeys';
import { verifyJwt } from '../../src/core/jwt';
import { registerModules } from '../../src/core/registry';
import keysRoutes from '../../src/core/routes/keys';
import tokenRoutes from '../../src/core/routes/token';
import type { Env } from '../../src/env';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { anon, auditRows, mount, ORG_A, ORG_B, session, tableRows, useModules, viaJwt, viaKey } from './helpers';
import type { Caller } from './helpers';

let t: TestEnv;
const keys = (who: Caller, env: Env = t.env) => mount(env, keysRoutes, '/api/v1/keys', who);
const tokens = (who: Caller, env: Env = t.env) => mount(env, tokenRoutes, '/api/v1/token', who);
const newKey = { name: 'Deploy script', scopes: ['links:read'] };

beforeEach(() => {
  t = createTestEnv();
  useModules();
});
afterEach(() => {
  registerModules([]);
  vi.useRealTimers();
});

describe('/api/v1/keys', () => {
  it('makes a key and shows the secret in that one response', async () => {
    const admin = keys(session('admin'));
    const made = await admin('POST', '/api/v1/keys', { ...newKey, expiresInDays: 30 });
    expect(made.status).toBe(201);
    expect(made.headers.get('cache-control')).toBe('no-store');
    expect(made.json.secret).toMatch(/^ts_test_[0-9A-Za-z]{46}$/);
    expect(made.json.key).toMatchObject({ name: 'Deploy script', scopes: ['links:read'], role: 'admin', kind: 'personal', userId: 'usr_admin', status: 'active', createdByLabel: 'usr_admin@example.com' });
    expect(made.json.key.expiresAt - made.json.key.createdAt).toBe(30 * 24 * 3600 * 1000);
    expect(await verifyApiKey(t.env, made.json.secret)).toMatchObject({ keyId: made.json.key.id, orgId: ORG_A });

    const list = await admin('GET', '/api/v1/keys');
    expect(list.status).toBe(200);
    expect(list.headers.get('cache-control')).toBe('no-store');
    expect(list.json.keys).toEqual([made.json.key]);
    const one = await admin('GET', `/api/v1/keys/${made.json.key.id}`);
    expect(one.json).toEqual({ key: made.json.key });
    for (const body of [list.json, one.json]) {
      const text = JSON.stringify(body);
      expect(text).not.toContain(made.json.secret.slice(16, 48));
      expect(text).not.toMatch(/secret|hash/i);
    }
    expect(auditRows(t, 'api_key.created')[0]).toMatchObject({ actor_id: 'usr_admin', actor_label: 'usr_admin@example.com', ip: '203.0.113.7' });
  });

  it('gives the owner an Admin key, never an owner key', async () => {
    const owner = keys(session('owner'));
    expect((await owner('POST', '/api/v1/keys', newKey)).json.key.role).toBe('admin');
    const asOwner = await owner('POST', '/api/v1/keys', { ...newKey, role: 'owner' });
    expect(asOwner.status).toBe(422);
    expect(asOwner.json.fields).toHaveProperty('role');
  });

  it('renames, and changes nothing else', async () => {
    const admin = keys(session('admin'));
    const { json: made } = await admin('POST', '/api/v1/keys', newKey);
    const path = `/api/v1/keys/${made.key.id}`;
    expect((await admin('PATCH', path, { name: 'CI' })).json.key.name).toBe('CI');

    for (const [body, field] of [
      [{ scopes: ['*'] }, 'scopes'],
      [{ name: 'CI', role: 'admin' }, 'role'],
      [{ expiresInDays: 3650 }, 'expiresInDays'],
    ] as const) {
      const res = await admin('PATCH', path, body);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe('validation_failed');
      expect(res.json.fields).toHaveProperty(field);
    }
    expect((await admin('GET', path)).json.key).toMatchObject({ name: 'CI', scopes: ['links:read'], expiresAt: null });
  });

  it('rotates with no body, or with a grace time', async () => {
    const admin = keys(session('admin'));
    const { json: first } = await admin('POST', '/api/v1/keys', newKey);
    const second = await admin('POST', `/api/v1/keys/${first.key.id}/rotate`);
    expect(second.status).toBe(200);
    expect(second.headers.get('cache-control')).toBe('no-store');
    expect(second.json.previous).toMatchObject({ id: first.key.id, status: 'revoked', replacedBy: second.json.key.id });
    expect(await verifyApiKey(t.env, first.secret)).toBeNull();
    expect(await verifyApiKey(t.env, second.json.secret)).not.toBeNull();

    const third = await admin('POST', `/api/v1/keys/${second.json.key.id}/rotate`, { graceSeconds: 60 });
    expect(third.json.previous.status).toBe('active');
    expect(await verifyApiKey(t.env, second.json.secret)).not.toBeNull();
    expect(await verifyApiKey(t.env, third.json.secret)).not.toBeNull();

    const path = `/api/v1/keys/${third.json.key.id}/rotate`;
    expect((await admin('POST', path, 'not json')).json).toMatchObject({ code: 'bad_request' });
    expect((await admin('POST', path, '[1]')).status).toBe(400);
    expect((await admin('POST', path, { graceSeconds: -5 })).json.fields).toHaveProperty('graceSeconds');
    expect((await admin('POST', `/api/v1/keys/${first.key.id}/rotate`)).json).toMatchObject({ code: 'keys.revoked' });
  });

  it('revokes, and lists revoked keys only when asked', async () => {
    const admin = keys(session('admin'));
    const { json: made } = await admin('POST', '/api/v1/keys', newKey);
    const gone = await admin('DELETE', `/api/v1/keys/${made.key.id}`);
    expect(gone.status).toBe(200);
    expect(gone.json.key.status).toBe('revoked');
    expect(await verifyApiKey(t.env, made.secret)).toBeNull();
    expect((await admin('GET', '/api/v1/keys')).json.keys).toEqual([]);
    expect((await admin('GET', '/api/v1/keys?include=revoked')).json.keys).toHaveLength(1);
    expect((await admin('DELETE', `/api/v1/keys/${made.key.id}`)).status).toBe(200);
  });

  it('answers every error in the same shape', async () => {
    const admin = keys(session('admin'));
    const missing = await admin('GET', '/api/v1/keys/key_missing');
    expect(missing.status).toBe(404);
    expect(missing.json).toEqual({ code: 'not_found', message: 'There is no key with that id. It may have been deleted.', requestId: 'req_test' });
    expect(missing.headers.get('cache-control')).toBe('no-store');

    const scope = await admin('POST', '/api/v1/keys', { name: 'Bad', scopes: ['nope:read'] });
    expect(scope.status).toBe(422);
    expect(Object.keys(scope.json).sort()).toEqual(['code', 'fields', 'message', 'requestId']);
    expect(scope.json).toMatchObject({ code: 'keys.unknown_scope', requestId: 'req_test' });
    expect(scope.json.fields.scopes).toContain('nope:read');

    const empty = await admin('POST', '/api/v1/keys', {});
    expect(empty.status).toBe(422);
    expect(Object.keys(empty.json.fields).sort()).toEqual(['name', 'scopes']);

    for (const body of ['not json', '"text"', '[]']) {
      const res = await admin('POST', '/api/v1/keys', body);
      expect(res.status).toBe(400);
      expect(res.json.code).toBe('bad_request');
    }
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
  });

  it('is for workspace admins', async () => {
    const { json: made } = await keys(session('admin'))('POST', '/api/v1/keys', newKey);
    for (const who of [session('member'), session('viewer'), viaKey('member', ['*']), viaJwt('viewer', ['*'])]) {
      const call = keys(who);
      for (const [method, path, body] of [
        ['GET', '/api/v1/keys'],
        ['GET', `/api/v1/keys/${made.key.id}`],
        ['GET', '/api/v1/keys/scopes'],
        ['GET', '/api/v1/keys/service-accounts'],
        ['POST', '/api/v1/keys', newKey],
        ['PATCH', `/api/v1/keys/${made.key.id}`, { name: 'Mine now' }],
        ['DELETE', `/api/v1/keys/${made.key.id}`],
        ['POST', `/api/v1/keys/${made.key.id}/rotate`],
      ] as const) {
        const res = await call(method, path, body);
        expect(res.status, `${who.auth.kind} ${who.org?.role} ${method} ${path}`).toBe(403);
        expect(res.json.code).toBe('forbidden');
      }
    }
    const nobody = await keys(anon)('GET', '/api/v1/keys');
    expect(nobody.status).toBe(401);
    expect(nobody.json.code).toBe('unauthorized');
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
    expect(await verifyApiKey(t.env, made.secret)).not.toBeNull();
  });

  it('lets a key or token read, with Admin role and the * permission, but never change anything', async () => {
    const admin = keys(session('admin'));
    const { json: made } = await admin('POST', '/api/v1/keys', newKey);
    const { json: bot } = await admin('POST', '/api/v1/keys/service-accounts', { name: 'Bot', role: 'viewer' });

    for (const who of [viaKey('admin', ['*']), viaJwt('admin', ['*'])]) {
      const call = keys(who);
      expect((await call('GET', '/api/v1/keys')).json.keys).toHaveLength(1);
      expect((await call('GET', `/api/v1/keys/${made.key.id}`)).status).toBe(200);
      expect((await call('GET', '/api/v1/keys/scopes')).status).toBe(200);
      expect((await call('GET', '/api/v1/keys/service-accounts')).json.serviceAccounts).toHaveLength(1);

      for (const [method, path, body] of [
        ['POST', '/api/v1/keys', { name: 'Wider', scopes: ['*'], role: 'admin' }],
        ['POST', '/api/v1/keys', { name: 'Narrower', scopes: ['links:read'], role: 'viewer' }],
        ['PATCH', `/api/v1/keys/${made.key.id}`, { name: 'Renamed' }],
        ['DELETE', `/api/v1/keys/${made.key.id}`],
        ['POST', `/api/v1/keys/${made.key.id}/rotate`],
        ['POST', '/api/v1/keys/service-accounts', { name: 'Another', role: 'admin' }],
        ['PATCH', `/api/v1/keys/service-accounts/${bot.serviceAccount.id}`, { role: 'admin' }],
        ['DELETE', `/api/v1/keys/service-accounts/${bot.serviceAccount.id}`],
      ] as const) {
        const res = await call(method, path, body);
        expect(res.status, `${who.auth.kind} ${method} ${path}`).toBe(403);
        expect(res.json.code).toBe('keys.session_required');
      }
    }
    for (const scopes of [['links:write'], ['links:*', 'forms:read'], []]) {
      const res = await keys(viaKey('admin', scopes))('GET', '/api/v1/keys');
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('forbidden');
    }

    expect(tableRows(t, 'api_keys')).toHaveLength(1);
    expect(tableRows<{ role: string }>(t, 'service_accounts').map((r) => r.role)).toEqual(['viewer']);
    expect((await admin('GET', `/api/v1/keys/${made.key.id}`)).json.key).toMatchObject({ name: 'Deploy script', status: 'active' });
  });

  it('lists the scopes a key can have', async () => {
    const res = await keys(session('admin'))('GET', '/api/v1/keys/scopes');
    expect(res.json).toEqual({
      scopes: [
        { module: 'forms', scope: 'forms:read', label: 'See forms and answers' },
        { module: 'links', scope: 'links:read', label: 'See links' },
        { module: 'links', scope: 'links:write', label: 'Create, edit and delete links' },
      ],
    });
  });

  it('manages service accounts and their keys', async () => {
    const admin = keys(session('admin'));
    const made = await admin('POST', '/api/v1/keys/service-accounts', { name: 'Deploy bot', role: 'member' });
    expect(made.status).toBe(201);
    const id = made.json.serviceAccount.id as string;
    expect(made.json.serviceAccount).toMatchObject({ name: 'Deploy bot', role: 'member', keyCount: 0 });
    expect((await admin('POST', '/api/v1/keys/service-accounts', { name: 'deploy bot', role: 'viewer' })).json).toMatchObject({ code: 'keys.name_taken' });

    const key = await admin('POST', '/api/v1/keys', { ...newKey, serviceAccountId: id });
    expect(key.json.key).toMatchObject({ kind: 'service', serviceAccountId: id, serviceAccountName: 'Deploy bot', role: 'member', userId: null });
    expect((await admin('GET', '/api/v1/keys/service-accounts')).json.serviceAccounts).toMatchObject([{ id, keyCount: 1 }]);

    expect((await admin('PATCH', `/api/v1/keys/service-accounts/${id}`, { role: 'viewer' })).json.serviceAccount.role).toBe('viewer');
    expect((await verifyApiKey(t.env, key.json.secret))!.role).toBe('viewer');

    expect((await admin('DELETE', `/api/v1/keys/service-accounts/${id}`)).json).toEqual({ revokedKeys: 1 });
    expect(await verifyApiKey(t.env, key.json.secret)).toBeNull();
    expect((await admin('DELETE', `/api/v1/keys/service-accounts/${id}`)).status).toBe(404);
  });

  it('keeps workspaces apart', async () => {
    const admin = keys(session('admin'));
    const { json: made } = await admin('POST', '/api/v1/keys', newKey);
    const { json: bot } = await admin('POST', '/api/v1/keys/service-accounts', { name: 'Bot', role: 'viewer' });

    // The same person, signed in to another workspace, and that workspace's owner.
    for (const who of [session('admin', 'usr_admin', ORG_B), session('owner', 'usr_owner_b', ORG_B), viaKey('admin', ['*'], 'key_b', ORG_B)]) {
      const other = keys(who);
      expect((await other('GET', '/api/v1/keys?include=revoked')).json.keys).toEqual([]);
      expect((await other('GET', '/api/v1/keys/service-accounts')).json.serviceAccounts).toEqual([]);
      expect((await other('GET', `/api/v1/keys/${made.key.id}`)).status).toBe(404);
      if (who.auth.kind !== 'session') continue;
      for (const [method, path, body] of [
        ['PATCH', `/api/v1/keys/${made.key.id}`, { name: 'Stolen' }],
        ['DELETE', `/api/v1/keys/${made.key.id}`],
        ['POST', `/api/v1/keys/${made.key.id}/rotate`],
        ['POST', '/api/v1/keys', { ...newKey, serviceAccountId: bot.serviceAccount.id }],
        ['PATCH', `/api/v1/keys/service-accounts/${bot.serviceAccount.id}`, { role: 'admin' }],
        ['DELETE', `/api/v1/keys/service-accounts/${bot.serviceAccount.id}`],
      ] as const) {
        expect((await other(method, path, body)).status, `${method} ${path}`).toBe(404);
      }
    }
    expect(await verifyApiKey(t.env, made.secret)).toMatchObject({ orgId: ORG_A, name: 'Deploy script' });
    expect(tableRows<{ org_id: string }>(t, 'api_keys').every((r) => r.org_id === ORG_A)).toBe(true);
  });
});

describe('POST /api/v1/token', () => {
  it('swaps a session for a 15 minute token', async () => {
    const before = Date.now();
    const res = await tokens(session('owner'))('POST', '/api/v1/token');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.json).toMatchObject({ tokenType: 'Bearer', expiresIn: 900, role: 'admin', scopes: ['*'] });
    expect(res.json.expiresAt).toBeGreaterThanOrEqual(before + 899_000);
    expect(res.json.expiresAt).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(await verifyJwt(t.env, res.json.token)).toMatchObject({ sub: 'usr_owner', orgId: ORG_A, role: 'admin', scopes: ['*'], kind: 'user', iss: 'http://localhost', aud: 'toolshed' });
  });

  it('swaps an API key for a token with the same reach', async () => {
    const res = await tokens(viaKey('member', ['forms:read', 'links:write'], 'key_abc'))('POST', '/api/v1/token', {});
    expect(res.json).toMatchObject({ role: 'member', scopes: ['forms:read', 'links:write'] });
    expect(await verifyJwt(t.env, res.json.token)).toMatchObject({ sub: 'key_abc', kind: 'key', orgId: ORG_A, role: 'member', scopes: ['forms:read', 'links:write'] });
  });

  it('works end to end from a key made over the API', async () => {
    const made = await keys(session('admin'))('POST', '/api/v1/keys', { name: 'CI', scopes: ['links:write'], role: 'member' });
    // What the request loader does with `Authorization: Bearer <key>`.
    const key = (await verifyApiKey(t.env, made.json.secret))!;
    const caller: Caller = { user: null, org: { id: key.orgId, role: key.role }, auth: { kind: 'apikey', scopes: key.scopes, keyId: key.keyId } };

    const res = await tokens(caller)('POST', '/api/v1/token', { scopes: ['links:read'] });
    expect(res.status).toBe(200);
    expect(await verifyJwt(t.env, res.json.token)).toMatchObject({ sub: key.keyId, kind: 'key', orgId: ORG_A, role: 'member', scopes: ['links:read'] });
    // A key is not a token and a token is not a key.
    expect(await verifyJwt(t.env, made.json.secret)).toBeNull();
    expect(await verifyApiKey(t.env, res.json.token)).toBeNull();
    expect((await tokens(caller)('POST', '/api/v1/token', { role: 'admin' })).status).toBe(403);
  });

  it('gives fewer permissions when asked', async () => {
    for (const [held, wanted, got] of [
      [['links:write'], ['links:read'], ['links:read']],
      [['links:*'], ['links:write', 'links:read', 'links:read'], ['links:read', 'links:write']],
      [['*'], ['links:*'], ['links:*']],
      [['*'], ['forms:read', '*'], ['*']],
      [['links:write', 'forms:read'], ['forms:read'], ['forms:read']],
    ] as const) {
      const res = await tokens(viaKey('admin', [...held]))('POST', '/api/v1/token', { scopes: wanted });
      expect(res.status, JSON.stringify([held, wanted])).toBe(200);
      expect(res.json.scopes).toEqual(got);
      expect((await verifyJwt(t.env, res.json.token))!.scopes).toEqual(got);
    }
  });

  it('never gives more permissions than the caller has', async () => {
    for (const [held, wanted] of [
      [['links:read'], ['links:write']],
      [['links:read'], ['links:*']],
      [['links:write'], ['links:*']],
      [['links:write'], ['*']],
      [['links:*'], ['forms:read']],
      [['links:*'], ['links:read', 'forms:read']],
      [[], ['links:read']],
    ] as const) {
      const res = await tokens(viaKey('admin', [...held]))('POST', '/api/v1/token', { scopes: wanted });
      expect(res.status, JSON.stringify([held, wanted])).toBe(403);
      expect(res.json.code).toBe('token.scope_too_wide');
      expect(res.json.fields).toHaveProperty('scopes');
      expect(res.json.token).toBeUndefined();
    }
    const unknown = await tokens(session('owner'))('POST', '/api/v1/token', { scopes: ['nope:read'] });
    expect(unknown.status).toBe(422);
    expect(unknown.json.code).toBe('keys.unknown_scope');
  });

  it('never gives a stronger role than the caller has', async () => {
    for (const [who, wanted] of [
      [viaKey('member', ['*']), 'admin'],
      [viaKey('viewer', ['*']), 'member'],
      [session('viewer'), 'admin'],
      [session('member'), 'admin'],
    ] as const) {
      const res = await tokens(who)('POST', '/api/v1/token', { role: wanted });
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('token.role_too_high');
    }
    const asOwner = await tokens(session('owner'))('POST', '/api/v1/token', { role: 'owner' });
    expect(asOwner.status).toBe(422);
    expect(asOwner.json.fields).toHaveProperty('role');

    const lower = await tokens(viaKey('admin', ['*']))('POST', '/api/v1/token', { role: 'viewer' });
    expect(lower.json.role).toBe('viewer');
    expect((await verifyJwt(t.env, lower.json.token))!.role).toBe('viewer');
    expect((await tokens(session('viewer'))('POST', '/api/v1/token')).json.role).toBe('viewer');
    expect((await tokens(session('owner'))('POST', '/api/v1/token', { role: 'admin' })).json.role).toBe('admin');
  });

  it('refuses a token asking for another token, and anyone not signed in', async () => {
    const renew = await tokens(viaJwt('admin', ['*']))('POST', '/api/v1/token');
    expect(renew.status).toBe(403);
    expect(renew.json.code).toBe('token.not_renewable');
    const nobody = await tokens(anon)('POST', '/api/v1/token');
    expect(nobody.status).toBe(401);
    expect(nobody.json.code).toBe('unauthorized');
    expect(tableRows(t, 'jwt_signing_keys')).toHaveLength(0);
  });

  it('checks the body', async () => {
    const call = tokens(session('admin'));
    for (const body of [{ scope: ['links:read'] }, { scopes: [] }, { scopes: 'links:read' }, { scopes: [7] }, { ttlSeconds: 86_400 }, []]) {
      const res = await call('POST', '/api/v1/token', body);
      expect(res.status, JSON.stringify(body)).toBe(422);
      expect(res.json.code).toBe('validation_failed');
    }
    const broken = await call('POST', '/api/v1/token', '{"scopes":');
    expect(broken.status).toBe(400);
    expect(broken.json).toEqual({ code: 'bad_request', message: 'Send a JSON body, or no body at all.', requestId: 'req_test' });
  });

  it('limits how often one caller can ask', async () => {
    // A fixed clock, so the one-minute window cannot roll over halfway through.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 0, 15, 12, 0, 5) });
    const call = tokens(viaKey('admin', ['*'], 'key_busy'));
    for (let i = 0; i < 60; i++) expect((await call('POST', '/api/v1/token')).status).toBe(200);
    const over = await call('POST', '/api/v1/token');
    expect(over.status).toBe(429);
    expect(over.json.code).toBe('rate_limited');
    expect(over.json.token).toBeUndefined();
    expect(Number(over.headers.get('retry-after'))).toBe(55);
    // Someone else is not held back.
    expect((await tokens(viaKey('admin', ['*'], 'key_quiet'))('POST', '/api/v1/token')).status).toBe(200);
    vi.setSystemTime(Date.UTC(2026, 0, 15, 12, 1, 0));
    expect((await call('POST', '/api/v1/token')).status).toBe(200);
  });

  it('names APP_URL as the issuer, or the request’s address when APP_URL is not set', async () => {
    const viaOtherHost = await tokens(session('admin'))('POST', '/api/v1/token', undefined, 'https://evil.example.com');
    expect((await verifyJwt(t.env, viaOtherHost.json.token))!.iss).toBe('http://localhost');

    const bare: Env = { ...t.env };
    delete bare.APP_URL;
    const res = await tokens(session('admin'), bare)('POST', '/api/v1/token', undefined, 'https://tools.example.com');
    expect(await verifyJwt(bare, res.json.token, { issuer: 'https://tools.example.com' })).toMatchObject({ iss: 'https://tools.example.com' });
    expect(await verifyJwt(bare, res.json.token, { issuer: 'https://evil.example.com' })).toBeNull();
  });
});

describe('GET /.well-known/jwks.json', () => {
  it('is public, cacheable, and holds only public keys', async () => {
    const open = tokens(anon);
    const empty = await open('GET', '/.well-known/jwks.json');
    expect(empty.status).toBe(200);
    expect(empty.json).toEqual({ keys: [] });

    const { json: issued } = await tokens(session('admin'))('POST', '/api/v1/token');
    // A second instance, as a stranger's request would likely reach.
    const res = await mount({ ...t.env, DB: Object.create(t.env.DB) as D1Database }, tokenRoutes, '/api/v1/token', anon)('GET', '/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.json.keys).toHaveLength(1);
    expect(Object.keys(res.json.keys[0]).sort()).toEqual(['alg', 'crv', 'kid', 'kty', 'use', 'x', 'y']);

    const header = JSON.parse(Buffer.from((issued.token as string).split('.')[0]!, 'base64url').toString('utf8')) as { kid: string };
    expect(res.json.keys[0].kid).toBe(header.kid);
  });
});
