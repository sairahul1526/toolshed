import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { getAuth, baseUrl, secureCookies } from '../../src/auth/auth';
import { safeEqual, verifyBase64Hmac } from '../../src/auth/crypto';
import { guardInit } from '../../src/auth/init-guard';
import { loadAuth } from '../../src/auth/load';
import { currentSession, readSignedToken, sessionCookieName } from '../../src/auth/session';
import { SESSION_REFRESH_SEC } from '../../src/auth/config';
import * as apikeys from '../../src/core/apikeys';
import * as jwt from '../../src/core/jwt';
import type { AppEnv } from '../../src/env';
import { countQueries, createTestSession, signSessionToken } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';

function probe() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('user', null);
    c.set('org', null);
    c.set('auth', { kind: 'anon', scopes: [] });
    await next();
  });
  app.use('*', loadAuth);
  app.get('/who', async (c) => c.json({ user: c.get('user'), org: c.get('org'), auth: c.get('auth'), session: await currentSession(c) }));
  return app;
}

interface Who {
  user: { id: string; email: string; isInstanceOwner: boolean } | null;
  org: { id: string; role: string } | null;
  auth: { kind: string; scopes: string[]; keyId?: string };
  session: { id: string; impersonatedBy: string | null } | null;
}

async function who(app: Hono<AppEnv>, env: AppEnv['Bindings'], headers: Record<string, string> = {}): Promise<{ res: Response; body: Who }> {
  const res = await app.request('/who', { headers }, env);
  return { res, body: (await res.json()) as Who };
}

describe('init guard', () => {
  it('returns the same value to every caller and starts once', async () => {
    const start = vi.fn(async () => ({ n: 1 }));
    const g = guardInit(start, 50);
    const [a, b] = await Promise.all([g.get(), g.get()]);
    expect(a).toBe(b);
    expect(await g.get()).toBe(a);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('drops a start that never settles and tries again', async () => {
    let calls = 0;
    const g = guardInit(() => (++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve('ok')), 20);
    expect(await g.get()).toBe('ok');
    expect(calls).toBe(2);
  });

  it('gives up after two stalled starts, and does not cache a failure', async () => {
    const stalled = guardInit(() => new Promise<string>(() => {}), 10);
    await expect(stalled.get()).rejects.toThrow('Sign-in did not start in time.');

    let calls = 0;
    const flaky = guardInit(async () => {
      if (++calls === 1) throw new Error('bad setting');
      return 'ok';
    }, 50);
    await expect(flaky.get()).rejects.toThrow('bad setting');
    expect(await flaky.get()).toBe('ok');
  });
});

describe('addresses and cookies', () => {
  it('uses APP_URL, then the request, and keeps only the origin', () => {
    const t = createTestEnv({ APP_URL: 'https://tools.example.com/some/path?x=1' });
    expect(baseUrl(t.env, 'https://other.example.com/a')).toBe('https://tools.example.com');
    const none = createTestEnv({ APP_URL: '' });
    expect(baseUrl(none.env, 'https://other.example.com/a?b')).toBe('https://other.example.com');
    expect(() => baseUrl(none.env)).toThrow();
    const broken = createTestEnv({ APP_URL: 'javascript:alert(1)' });
    expect(baseUrl(broken.env, 'https://ok.example.com/')).toBe('https://ok.example.com');
  });

  it('relaxes Secure only for plain http on this machine', () => {
    expect(secureCookies('http://localhost')).toBe(false);
    expect(secureCookies('http://127.0.0.1:8787')).toBe(false);
    expect(secureCookies('https://localhost')).toBe(true);
    expect(secureCookies('http://tools.example.com')).toBe(true);
    expect(sessionCookieName('https://tools.example.com')).toBe('__Secure-toolshed.session_token');
    expect(sessionCookieName('http://localhost')).toBe('toolshed.session_token');
  });

  it('compares in constant time and rejects forged signatures', async () => {
    expect(await safeEqual('abc', 'abc')).toBe(true);
    expect(await safeEqual('abc', 'abd')).toBe(false);
    expect(await safeEqual('abc', 'abcd')).toBe(false);
    const signed = decodeURIComponent(await signSessionToken('secret-a', 'tok'));
    expect(await readSignedToken('secret-a', signed)).toBe('tok');
    expect(await readSignedToken('secret-b', signed)).toBeNull();
    expect(await readSignedToken('secret-a', 'tok')).toBeNull();
    expect(await readSignedToken('secret-a', `tok.${'A'.repeat(44)}`)).toBeNull();
    expect(await readSignedToken('secret-a', undefined)).toBeNull();
    expect(await verifyBase64Hmac('secret-a', 'tok', '%%%not-base64%%%')).toBe(false);
  });
});

describe('loadAuth', () => {
  it('leaves a request with no credentials anonymous', async () => {
    const t = createTestEnv();
    const { body } = await who(probe(), t.env);
    expect(body).toEqual({ user: null, org: null, auth: { kind: 'anon', scopes: [] }, session: null });
  });

  it('reads a session cookie in one query', async () => {
    const t = createTestEnv();
    const s = await createTestSession(t.env, { role: 'admin', email: 'Ada@Example.com', instanceOwner: true });
    const app = probe();
    const { result, queries } = await countQueries(t.env, () => who(app, t.env, s.headers));
    expect(queries).toHaveLength(1);
    expect(result.body.user).toMatchObject({ id: s.user.id, email: 'ada@example.com', isInstanceOwner: true });
    expect(result.body.org).toMatchObject({ id: 'org_test', role: 'admin' });
    expect(result.body.auth).toEqual({ kind: 'session', scopes: ['*'] });
    expect(result.body.session).toMatchObject({ id: s.sessionId, impersonatedBy: null });
    expect(result.res.headers.get('set-cookie')).toBeNull();
  });

  it('pushes an old session forward with one more query and re-sends the cookie', async () => {
    const t = createTestEnv();
    const s = await createTestSession(t.env);
    const old = new Date(Date.now() - (SESSION_REFRESH_SEC + 60) * 1000).toISOString();
    t.sqlite.prepare('UPDATE "session" SET "updatedAt" = ? WHERE "id" = ?').run(old, s.sessionId);
    const app = probe();
    const { result, queries } = await countQueries(t.env, () => who(app, t.env, s.headers));
    expect(queries).toHaveLength(2);
    const cookie = result.res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('toolshed.session_token=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    const row = t.sqlite.prepare('SELECT "updatedAt" FROM "session" WHERE "id" = ?').get(s.sessionId) as { updatedAt: string };
    expect(Date.parse(row.updatedAt)).toBeGreaterThan(Date.now() - 5000);
  });

  it('never extends a "signed in as" session', async () => {
    const t = createTestEnv();
    const s = await createTestSession(t.env);
    const old = new Date(Date.now() - (SESSION_REFRESH_SEC + 60) * 1000).toISOString();
    t.sqlite.prepare('UPDATE "session" SET "updatedAt" = ?, "impersonatedBy" = ? WHERE "id" = ?').run(old, 'usr_owner', s.sessionId);
    const { result, queries } = await countQueries(t.env, () => who(probe(), t.env, s.headers));
    expect(queries).toHaveLength(1);
    expect(result.body.session?.impersonatedBy).toBe('usr_owner');
    expect(result.res.headers.get('set-cookie')).toBeNull();
  });

  it('treats expired sessions, banned people and forged cookies as signed out', async () => {
    const t = createTestEnv();
    const app = probe();
    const expired = await createTestSession(t.env);
    t.sqlite.prepare('UPDATE "session" SET "expiresAt" = ? WHERE "id" = ?').run(new Date(Date.now() - 1000).toISOString(), expired.sessionId);
    expect((await who(app, t.env, expired.headers)).body.auth.kind).toBe('anon');

    const banned = await createTestSession(t.env);
    t.sqlite.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?').run(banned.user.id);
    expect((await who(app, t.env, banned.headers)).body.auth.kind).toBe('anon');
    t.sqlite.prepare('UPDATE "user" SET "banExpires" = ? WHERE "id" = ?').run(new Date(Date.now() - 1000).toISOString(), banned.user.id);
    expect((await who(app, t.env, banned.headers)).body.auth.kind).toBe('session');

    const good = await createTestSession(t.env);
    const [name, value] = good.cookie.split('=') as [string, string];
    const token = decodeURIComponent(value).split('.')[0]!;
    const forged = `${name}=${await signSessionToken('another-secret', token)}`;
    expect((await who(app, t.env, { cookie: forged })).body.auth.kind).toBe('anon');
    for (const junk of [`${name}=`, `${name}=%E0%A4%A`, `${name}=${'x'.repeat(5000)}`, `${name}=a.b.c`, 'unrelated=1']) {
      const { res, body } = await who(app, t.env, { cookie: junk });
      expect(res.status).toBe(200);
      expect(body.auth.kind).toBe('anon');
    }
  });

  it('has no workspace when the person is not a member of the active one', async () => {
    const t = createTestEnv();
    const s = await createTestSession(t.env);
    t.sqlite.prepare('DELETE FROM "member" WHERE "userId" = ?').run(s.user.id);
    const { body } = await who(probe(), t.env, s.headers);
    expect(body.auth.kind).toBe('session');
    expect(body.org).toBeNull();
  });

  it('accepts an API key with the key’s scopes and role, and no user', async () => {
    const t = createTestEnv();
    await createTestSession(t.env);
    const spy = vi.spyOn(apikeys, 'verifyApiKey').mockImplementation(async (_env, token) =>
      token === 'ts_good' ? ({ orgId: 'org_test', keyId: 'key_1', name: 'CI', scopes: ['links:read'], role: 'member' } as apikeys.VerifiedKey) : null,
    );
    try {
      const app = probe();
      const { result, queries } = await countQueries(t.env, () => who(app, t.env, { authorization: 'Bearer ts_good' }));
      expect(queries).toHaveLength(1);
      expect(result.body.user).toBeNull();
      expect(result.body.org).toMatchObject({ id: 'org_test', role: 'member' });
      expect(result.body.auth).toEqual({ kind: 'apikey', scopes: ['links:read'], keyId: 'key_1' });
      expect((await who(app, t.env, { authorization: 'Bearer ts_bad' })).body.auth.kind).toBe('anon');
    } finally {
      spy.mockRestore();
    }
  });

  it('accepts a JWT, and ignores a cookie sent next to a bad token', async () => {
    const t = createTestEnv();
    const s = await createTestSession(t.env);
    const spy = vi.spyOn(jwt, 'verifyJwt').mockImplementation(async (_env, token) =>
      token === 'aaa.bbb.ccc' ? ({ sub: 'usr_1', orgId: 'org_test', role: 'viewer', scopes: ['forms:read'], exp: 0 } as jwt.JwtClaims) : null,
    );
    try {
      const app = probe();
      const ok = await who(app, t.env, { authorization: 'Bearer aaa.bbb.ccc' });
      expect(ok.body.auth).toEqual({ kind: 'jwt', scopes: ['forms:read'] });
      expect(ok.body.org).toMatchObject({ role: 'viewer' });
      expect(ok.body.user).toBeNull();
      for (const header of ['Bearer nope', 'Bearer ', 'Basic abc', 'Bearer a b', `Bearer ${'x'.repeat(9000)}`, '']) {
        const { res, body } = await who(app, t.env, { authorization: header, cookie: s.cookie });
        expect(res.status).toBe(200);
        expect(body.auth.kind).toBe('anon');
      }
    } finally {
      spy.mockRestore();
    }
  });
});

describe('Better Auth wrapper', () => {
  it('builds once per database and accepts the sessions our helper makes', async () => {
    const t = createTestEnv();
    const auth = await getAuth(t.env);
    expect(await getAuth(t.env)).toBe(auth);
    expect(await getAuth(createTestEnv().env)).not.toBe(auth);

    const s = await createTestSession(t.env);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: s.cookie }) });
    expect(session?.user.id).toBe(s.user.id);
    expect(session?.session.activeOrganizationId).toBe('org_test');
  });

  it('has no sign-up and no endpoints for our server-only actions', async () => {
    const t = createTestEnv();
    const auth = await getAuth(t.env);
    const post = (path: string, body: unknown) =>
      auth.handler(new Request(`http://localhost/api/auth${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost' }, body: JSON.stringify(body) }));
    expect((await post('/sign-up/email', { email: 'new@example.com', password: 'long-enough-password', name: 'New' })).status).toBeGreaterThanOrEqual(400);
    expect((await post('/issue-session', { userId: 'usr_x' })).status).toBe(404);
    expect((await post('/create-account', { email: 'new@example.com', name: 'New' })).status).toBe(404);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM "user"').get()).toEqual({ n: 0 });
  });
});
