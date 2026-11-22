import { beforeEach, describe, expect, it } from 'vitest';
import { CODE_MAX_ATTEMPTS, LIMITS } from '../../src/auth/config';
import { safeNext } from '../../src/auth/next';
import { sessionCookieName } from '../../src/auth/session';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, lastEmail, lastLink, ORIGIN, signInByCode, testApp } from './browser';

const EMAIL = 'ada@example.com';
const app = testApp();

let env: Env;
let userId: string;

const SESSION = sessionCookieName(ORIGIN);
const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const sessions = () => count('SELECT COUNT(*) AS n FROM "session" WHERE "userId" = ?1', userId);
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);

beforeEach(async () => {
  const t = createTestEnv();
  env = t.env;
  const seeded = await createTestSession(env, { email: EMAIL, name: 'Ada', instanceOwner: true });
  userId = seeded.user.id;
  await env.DB.prepare('DELETE FROM "session"').run();
});

describe('safeNext', () => {
  it('keeps same-site paths', () => {
    expect(safeNext('/app/links?tab=2#top')).toBe('/app/links?tab=2');
    expect(safeNext('/app/../app/x')).toBe('/app/x');
    expect(safeNext(undefined)).toBe('/app');
  });

  it('refuses anything that could leave the site or loop', () => {
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', 'app', '/app\nx', '/sign-in', '/sign-out', '/api/v1/x', '/setup', 'javascript:alert(1)', '/%2f/evil.example\u0000', 42, null]) {
      expect(safeNext(bad)).toBe('/app');
    }
  });
});

describe('sign-in by emailed code', () => {
  it('signs in with the right code and lands on the page asked for', async () => {
    const b = new Browser(app, env);
    const start = await b.post('/sign-in', { email: ' Ada@Example.com ', intent: 'code', next: '/app/links' });
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('/sign-in/code');

    const mail = await lastEmail(env, EMAIL);
    expect(mail?.template).toBe('sign-in-code');
    expect((await b.get('/sign-in/code')).status).toBe(200);

    const done = await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/app/links');
    expect(b.cookies.has(SESSION)).toBe(true);
    expect(await b.signedIn()).toBe(true);
    expect(await audits('user.signed_in')).toBe(1);
  });

  it('sets the session cookie HttpOnly and SameSite=Lax, and Secure off localhost', async () => {
    const b = new Browser(app, env);
    const done = await signInByCode(b, env, EMAIL);
    const cookie = done.headers.getSetCookie().find((line) => line.startsWith(`${SESSION}=`))!;
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toMatch(/Secure/i);

    const live = createTestEnv({ APP_URL: 'https://tools.example.com' });
    await createTestSession(live.env, { email: EMAIL, instanceOwner: true });
    const res = await app.request(
      'https://tools.example.com/sign-in',
      { method: 'POST', headers: { origin: 'https://tools.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${EMAIL}&intent=code` },
      live.env,
    );
    const flow = res.headers.getSetCookie().find((line) => line.includes('toolshed.flow.sign-in'))!;
    expect(flow.startsWith('__Secure-')).toBe(true);
    expect(flow).toMatch(/Secure/);
    expect(flow).toMatch(/HttpOnly/);
  });

  it('never stores the code itself', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    const code = await lastCode(env, EMAIL);
    const row = await env.DB.prepare('SELECT * FROM auth_codes').first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(code);
  });

  it('says how many tries are left after a wrong code, then pauses', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    const right = await lastCode(env, EMAIL);
    const wrong = right === '000000' ? '000001' : '000000';

    const first = await b.post('/sign-in/code', { code: wrong });
    expect(first.status).toBe(400);
    expect(await first.text()).toContain(`${CODE_MAX_ATTEMPTS - 1} tries left`);

    let last = first;
    for (let i = 1; i < CODE_MAX_ATTEMPTS; i++) last = await b.post('/sign-in/code', { code: wrong });
    expect(last.status).toBe(303);
    expect(last.headers.get('location')).toBe('/sign-in/limited');
    const paused = await b.get('/sign-in/limited');
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain('Too many tries');

    // The right code no longer helps: the pause is on the address, not on the guess.
    const late = await b.post('/sign-in/code', { code: right });
    expect(late.headers.get('location')).toBe('/sign-in/limited');
    expect(await b.signedIn()).toBe(false);
    expect(await audits('user.sign_in_paused')).toBe(1);
  });

  it('refuses a code after it has expired', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    await env.DB.prepare('UPDATE auth_codes SET expires_at = ?1').bind(Date.now() - 1).run();
    const res = await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
    expect(await b.signedIn()).toBe(false);
  });

  it('refuses a code the second time', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    const replay = b.clone();
    const code = await lastCode(env, EMAIL);
    expect((await b.post('/sign-in/code', { code })).status).toBe(303);

    const again = await replay.post('/sign-in/code', { code });
    expect(again.status).toBe(400);
    expect(await again.text()).toContain('already used');
    expect(replay.cookies.has(SESSION)).toBe(false);
  });

  it('only accepts a code in the browser that asked for it', async () => {
    const asker = new Browser(app, env);
    await asker.post('/sign-in', { email: EMAIL, intent: 'code' });
    const code = await lastCode(env, EMAIL);

    const thief = new Browser(app, env, '203.0.113.99');
    const res = await thief.post('/sign-in/code', { code });
    expect(res.headers.get('location')).toBe('/sign-in');
    expect(thief.cookies.has(SESSION)).toBe(false);
  });

  it('stops sending codes to one address after the limit', async () => {
    const b = new Browser(app, env);
    for (let i = 0; i < LIMITS.codePerEmail.limit; i++) {
      expect((await b.post('/sign-in', { email: EMAIL, intent: 'code' })).headers.get('location')).toBe('/sign-in/code');
    }
    const over = await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    expect(over.headers.get('location')).toBe('/sign-in/limited');
    expect(await count('SELECT COUNT(*) AS n FROM email_log WHERE to_addr = ?1', EMAIL)).toBe(LIMITS.codePerEmail.limit);
  });

  it('treats an address with no account exactly like one with an account, but sends nothing', async () => {
    const known = new Browser(app, env);
    const unknown = new Browser(app, env);
    const a = await known.post('/sign-in', { email: EMAIL, intent: 'code' });
    const z = await unknown.post('/sign-in', { email: 'nobody@example.com', intent: 'code' });
    expect(z.status).toBe(a.status);
    expect(z.headers.get('location')).toBe(a.headers.get('location'));
    expect(await lastEmail(env, 'nobody@example.com')).toBeNull();

    const pageA = await (await known.get('/sign-in/code')).text();
    const pageZ = await (await unknown.get('/sign-in/code')).text();
    expect(pageZ.replace(/nobody@example\.com/g, EMAIL)).toBe(pageA);

    const wrongA = await known.post('/sign-in/code', { code: '000000' });
    const wrongZ = await unknown.post('/sign-in/code', { code: '000000' });
    expect(wrongZ.status).toBe(wrongA.status);
    expect((await wrongZ.text()).replace(/nobody@example\.com/g, EMAIL)).toBe(await wrongA.text());
    expect(await count('SELECT COUNT(*) AS n FROM "user"')).toBe(1);
  });

  it('rejects a form post from another site', async () => {
    const res = await app.request(
      '/sign-in',
      { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: `email=${EMAIL}&intent=code` },
      env,
    );
    expect(res.status).toBe(403);
    expect(await lastEmail(env, EMAIL)).toBeNull();
  });

  it('never sends the browser off-site after sign-in', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code', next: '//evil.example/x' });
    const done = await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });
    expect(done.headers.get('location')).toBe('/app');
  });

  it('starts a brand-new session and ends the one the browser held before', async () => {
    const planted = await createTestSession(env, { email: 'mallory@example.com' });
    const b = adopt(new Browser(app, env), planted.cookie);
    const before = b.cookies.get(SESSION);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });

    expect(b.cookies.get(SESSION)).not.toBe(before);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', planted.sessionId)).toBe(0);
    expect(await sessions()).toBe(1);
  });

  it('refuses a suspended account without saying so before the code is proved', async () => {
    await env.DB.prepare('UPDATE "user" SET "banned" = 1 WHERE "id" = ?1').bind(userId).run();
    const b = new Browser(app, env);
    expect((await b.post('/sign-in', { email: EMAIL, intent: 'code' })).headers.get('location')).toBe('/sign-in/code');
    const res = await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('suspended');
    expect(await sessions()).toBe(0);
  });
});

describe('the link in the sign-in email', () => {
  it('does nothing when it is only opened, however often', async () => {
    const b = new Browser(app, env);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    const link = await lastLink(env, EMAIL);

    const scanner = new Browser(app, env, '192.0.2.1');
    for (let i = 0; i < 3; i++) {
      const res = await scanner.get(link);
      expect(res.status).toBe(200);
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(await res.text()).toContain('Finish signing in');
    }
    expect(scanner.cookies.has(SESSION)).toBe(false);
    expect(await sessions()).toBe(0);
    expect(await count('SELECT COUNT(*) AS n FROM auth_codes WHERE used_at IS NOT NULL')).toBe(0);

    // The code in the same email still works after all that.
    expect((await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) })).status).toBe(303);
  });

  it('signs in when the button is pressed, once', async () => {
    const asker = new Browser(app, env);
    await asker.post('/sign-in', { email: EMAIL, intent: 'code', next: '/app/links' });
    const link = await lastLink(env, EMAIL);
    const code = await lastCode(env, EMAIL);

    const phone = new Browser(app, env, '192.0.2.44');
    const done = await phone.post(link);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/app/links');
    expect(await phone.signedIn()).toBe(true);

    const second = await new Browser(app, env).post(link);
    expect(second.status).toBe(400);
    expect(await second.text()).toContain('already used');
    expect((await new Browser(app, env).get(link)).status).toBe(400);

    // Using the link also uses up the code that came with it.
    const late = await asker.post('/sign-in/code', { code });
    expect(late.status).toBe(400);
    expect(await sessions()).toBe(1);
  });

  it('shows the same dead-link page for a made-up link', async () => {
    const res = await new Browser(app, env).get('/sign-in/link/not-a-real-token');
    expect(res.status).toBe(400);
    const post = await new Browser(app, env).post('/sign-in/link/not-a-real-token');
    expect(post.status).toBe(400);
    expect(await sessions()).toBe(0);
  });
});

describe('sign out and sign-up', () => {
  it('ends the session and clears the cookie', async () => {
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    const out = await b.post('/sign-out');
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/sign-in');
    expect(b.cookies.has(SESSION)).toBe(false);
    expect(await sessions()).toBe(0);
    expect(await audits('user.signed_out')).toBe(1);
    expect((await b.get('/sign-in')).status).toBe(200);
  });

  it('also signs out from the address the dashboard form posts to', async () => {
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    const cross = await app.request('/api/auth/sign-out', { method: 'POST', headers: { ...b.headers(), origin: 'https://evil.example' } }, env);
    expect(cross.status).toBe(403);
    expect(await sessions()).toBe(1);
    const out = await b.post('/api/auth/sign-out');
    expect(out.status).toBe(303);
    expect(out.headers.get('location')).toBe('/sign-in');
    expect(await sessions()).toBe(0);
  });

  it('needs a same-site post to sign out', async () => {
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    const res = await app.request('/sign-out', { method: 'POST', headers: { ...b.headers(), origin: 'https://evil.example' } }, env);
    expect(res.status).toBe(403);
    expect(await sessions()).toBe(1);
  });

  it('has no open sign-up', async () => {
    const res = await new Browser(app, env).get('/sign-up');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('invite');
  });

  it('lets a signed-in person prove it is still them', async () => {
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    const first = b.cookies.get(SESSION);
    const page = await b.get('/sign-in?again=1&next=/app/account');
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Sign in again');

    await b.post('/sign-in', { email: EMAIL, intent: 'code', next: '/app/account' });
    const done = await b.post('/sign-in/code', { code: await lastCode(env, EMAIL) });
    expect(done.headers.get('location')).toBe('/app/account');
    expect(b.cookies.get(SESSION)).not.toBe(first);
    expect(await sessions()).toBe(1);
  });
});

describe('passkey routes', () => {
  it('gives anyone sign-in options but nothing else', async () => {
    const b = new Browser(app, env);
    const options = await b.get('/api/auth/passkey/sign-in-options');
    expect(options.status).toBe(200);
    expect(options.headers.get('cache-control')).toBe('no-store');
    expect(((await options.json()) as { challenge?: string }).challenge).toBeTruthy();

    expect((await b.get('/api/auth/passkey/register-options')).status).toBe(401);
    expect((await b.postJson('/api/auth/passkey/register', { response: {} })).status).toBe(401);
  });

  it('refuses a made-up passkey answer', async () => {
    const b = new Browser(app, env);
    await b.get('/api/auth/passkey/sign-in-options');
    const res = await b.postJson('/api/auth/passkey/sign-in', { response: { id: 'x', rawId: 'x', type: 'public-key', response: {} } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('auth.passkey_failed');
    expect(b.cookies.has(SESSION)).toBe(false);
  });

  it('lets a freshly signed-in person start adding a passkey, and nobody else', async () => {
    const b = new Browser(app, env);
    await signInByCode(b, env, EMAIL);
    const options = await b.get('/api/auth/passkey/register-options?name=Laptop');
    expect(options.status).toBe(200);
    const body = (await options.json()) as { challenge?: string; rp?: { id: string } };
    expect(body.challenge).toBeTruthy();
    expect(body.rp?.id).toBe('localhost');

    await env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
    const stale = await b.get('/api/auth/passkey/register-options');
    expect(stale.status).toBe(403);
    expect(((await stale.json()) as { code: string }).code).toBe('auth.sign_in_again');
  });

  it('rejects a call from another site', async () => {
    const res = await app.request(
      '/api/auth/passkey/sign-in',
      { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{"response":{}}' },
      env,
    );
    expect(res.status).toBe(403);
  });
});
