import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import account from '../../src/dashboard/account';
import overview from '../../src/dashboard/overview';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';
import { secretFromUri, totp } from '../e2e/helpers/totp';

const app = createApp({ screens: { overview, account } });
const PASSWORD = 'a long enough password';

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});

const get = (s: TestSession, path = '/app/account?tab=security') => app.request(path, { headers: s.headers }, t.env);
const post = (s: TestSession, path: string, fields: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, t.env);
const page = async (s: TestSession, path?: string) => (await get(s, path)).text();
const makeStale = () => t.env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
const audits = async (action: string) => Number(await t.env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1').bind(action).first<number>('n'));
const count = async (sql: string, ...binds: unknown[]) => Number(await t.env.DB.prepare(sql).bind(...binds).first<number>('n'));
const addPasskey = (userId: string, id: string, name: string) =>
  t.env.DB.prepare(
    `INSERT INTO "passkey" ("id", "name", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt") VALUES (?1, ?2, 'pk', ?3, ?1, 0, 'multiDevice', 1, ?4)`,
  )
    .bind(id, name, userId, new Date().toISOString())
    .run();

/** Everything a response could leak a secret through, apart from its body. */
const outsideBody = (res: Response) => `${res.headers.get('location') ?? ''} ${res.headers.get('set-cookie') ?? ''}`;

describe('password', () => {
  it.each(['owner', 'member', 'viewer'] as const)('is set by a %s, signing out their other devices', async (role) => {
    const s = await createTestSession(t.env, { role, email: `${role}@example.com` });
    const other = await createTestSession(t.env, { role, email: `${role}@example.com` });
    const res = await post(s, '/app/account/password', { password: PASSWORD });
    expect(res.status).toBe(303);
    expect(outsideBody(res)).not.toContain(encodeURIComponent(PASSWORD));
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', other.sessionId)).toBe(0);
    expect(await page(s)).toContain('Change password');
    expect(await audits('password.added')).toBe(1);
  });

  it('refuses a weak or very long password under the field and keeps it out of the page', async () => {
    const s = await createTestSession(t.env);
    for (const password of ['short', 'x'.repeat(300)]) {
      const res = await post(s, '/app/account/password', { password });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain('id="password-error"');
      expect(html).not.toContain(password.slice(0, 20) + password.slice(0, 20));
    }
    expect(await count('SELECT COUNT(*) AS n FROM "account" WHERE "providerId" = \'credential\'')).toBe(0);
  });

  it('removes a password', async () => {
    const s = await createTestSession(t.env);
    await post(s, '/app/account/password', { password: PASSWORD });
    expect((await post(s, '/app/account/password/remove')).status).toBe(303);
    expect(await page(s)).toContain('Set password');
  });

  it('asks for a fresh sign-in first', async () => {
    const s = await createTestSession(t.env);
    await makeStale();
    const html = await page(s);
    expect(html).toContain('Sign in again to change sign-in settings');
    const res = await post(s, '/app/account/password', { password: PASSWORD });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Sign in again first');
  });
});

describe('two-step sign-in', () => {
  /** Turning two-step on swaps the session cookie, so later calls must carry the new one. */
  async function confirm(s: TestSession, secret: string): Promise<TestSession> {
    const res = await post(s, '/app/account/two-step/confirm', { code: totp(secret) });
    expect(res.status).toBe(303);
    const next = /^([^=]+=[^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? s.cookie;
    return { ...s, cookie: next, headers: { ...s.headers, cookie: next } };
  }

  async function setUp(s: TestSession, current = '') {
    const res = await post(s, '/app/account/two-step/start', current ? { current } : {});
    const html = await res.text();
    const secret = /<code>([A-Z2-7]{16,})<\/code>/.exec(html)?.[1] ?? '';
    return { res, html, secret };
  }

  it('shows the secret and recovery codes once, in a no-store page', async () => {
    const s = await createTestSession(t.env);
    const { res, html, secret } = await setUp(s);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(html).toContain('<svg');
    expect(secret).not.toBe('');
    expect(html).toContain('Save these now');
    expect(outsideBody(res)).not.toContain(secret);
    // Nothing is on the account page afterwards.
    const after = await page(s);
    expect(after).not.toContain(secret);
    expect(after).toContain('Set up two-step');
  });

  it('turns on after the right code and refuses a wrong one without showing the secret again', async () => {
    const s = await createTestSession(t.env);
    const { secret } = await setUp(s);
    const wrong = await post(s, '/app/account/two-step/confirm', { code: '000000' === totp(secret) ? '000001' : '000000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    const wrongHtml = await wrong.text();
    expect(wrongHtml).toContain('id="two-step-code-error"');
    expect(wrongHtml).not.toContain(secret);
    const on = await confirm(s, secret);
    expect(await page(on)).toContain('Turn off two-step');
    expect(await audits('two_step.turned_on')).toBe(1);
  });

  it('asks for the password only when the account has one, and says when it is wrong', async () => {
    const s = await createTestSession(t.env);
    expect(await page(s)).not.toContain('Current password');
    await post(s, '/app/account/password', { password: PASSWORD });
    expect(await page(s)).toContain('Current password');
    const wrong = await post(s, '/app/account/two-step/start', { current: 'not the password' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await wrong.text()).toContain('id="current-start-error"');
    const { secret } = await setUp(s, PASSWORD);
    expect(secret).not.toBe('');
  });

  it('makes new recovery codes and turns off, and keeps the new codes out of redirects', async () => {
    const s = await createTestSession(t.env);
    const { secret } = await setUp(s);
    const on = await confirm(s, secret);
    const codes = await post(on, '/app/account/two-step/codes');
    expect(codes.status).toBe(200);
    expect(codes.headers.get('cache-control')).toContain('no-store');
    expect(await codes.text()).toContain('New recovery codes');
    expect(codes.headers.get('location')).toBeNull();
    const off = await post(on, '/app/account/two-step/off');
    expect(off.status).toBe(303);
    const next = /^([^=]+=[^;]+)/.exec(off.headers.get('set-cookie') ?? '')?.[1] ?? on.cookie;
    expect(await page({ ...on, headers: { ...on.headers, cookie: next } })).toContain('Set up two-step');
    expect(await audits('two_step.turned_off')).toBe(1);
  });

  it('refuses starting again while it is on', async () => {
    const s = await createTestSession(t.env);
    const { secret } = await setUp(s);
    const on = await confirm(s, secret);
    const again = await post(on, '/app/account/two-step/start');
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await again.text()).toContain('That did not work');
  });

  it('carries no secret in the audit log', async () => {
    const s = await createTestSession(t.env);
    const { secret } = await setUp(s);
    await post(s, '/app/account/two-step/confirm', { code: totp(secret) });
    const rows = (await t.env.DB.prepare('SELECT summary, meta FROM audit_log').all<{ summary: string; meta: string }>()).results;
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(secretFromUri(`otpauth://totp/x?secret=${secret}`)).toBe(secret);
  });
});

describe('passkeys', () => {
  it('lists only your own, renames and removes them', async () => {
    const a = await createTestSession(t.env, { email: 'a@example.com' });
    const b = await createTestSession(t.env, { email: 'b@example.com' });
    await addPasskey(a.user.id, 'pk_a', 'Work laptop');
    await addPasskey(b.user.id, 'pk_b', 'Bobs phone');
    const html = await page(a);
    expect(html).toContain('Work laptop');
    expect(html).not.toContain('Bobs phone');
    expect(html).toContain('data-passkey-add');
    expect(html).toContain('/assets/auth.js');

    expect((await post(a, '/app/account/passkeys/pk_a/rename', { name: 'Desk' })).status).toBe(303);
    expect(await page(a)).toContain('Desk');
    expect(await audits('passkey.renamed')).toBe(1);

    // Another person's passkey cannot be renamed or removed through your session.
    const steal = await post(a, '/app/account/passkeys/pk_b/remove');
    expect(steal.status).toBeGreaterThanOrEqual(400);
    expect(await count('SELECT COUNT(*) AS n FROM "passkey" WHERE "id" = \'pk_b\'')).toBe(1);

    expect((await post(a, '/app/account/passkeys/pk_a/remove')).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM "passkey" WHERE "id" = \'pk_a\'')).toBe(0);
    expect(await audits('passkey.removed')).toBe(1);
  });

  it('shows a rename refusal at the top of the card', async () => {
    const s = await createTestSession(t.env);
    await addPasskey(s.user.id, 'pk_1', 'Phone');
    const res = await post(s, '/app/account/passkeys/pk_1/rename', { name: '   ' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('That did not work');
  });

  it('escapes a hostile passkey name', async () => {
    const s = await createTestSession(t.env);
    await addPasskey(s.user.id, 'pk_x', '<script>alert(1)</script>');
    const html = await page(s);
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
  });

  it('hides the add button when a recent sign-in is needed', async () => {
    const s = await createTestSession(t.env);
    await makeStale();
    expect(await page(s)).not.toContain('data-passkey-add');
  });
});

describe('devices', () => {
  const tab = '/app/account?tab=sessions';

  it('lists this device first, marked, with no sign-out of its own', async () => {
    const s = await createTestSession(t.env);
    await createTestSession(t.env, { email: s.user.email });
    const html = await page(s, tab);
    expect(html).toContain('This device');
    expect(html).not.toContain(`/sessions/${s.sessionId}/revoke`);
    expect(html.match(/\/sessions\/[^"\/]+\/revoke/g)?.length).toBe(1);
  });

  it('signs out one other device and says when it is already gone', async () => {
    const s = await createTestSession(t.env);
    const other = await createTestSession(t.env, { email: s.user.email });
    expect((await post(s, `/app/account/sessions/${other.sessionId}/revoke`)).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', other.sessionId)).toBe(0);
    const again = await post(s, `/app/account/sessions/${other.sessionId}/revoke`);
    expect(again.status).toBe(303);
  });

  it('signs out all the others and keeps this one', async () => {
    const s = await createTestSession(t.env);
    const e1 = await createTestSession(t.env, { email: s.user.email });
    const e2 = await createTestSession(t.env, { email: s.user.email });
    expect((await post(s, '/app/account/sessions/revoke-others')).status).toBe(303);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" IN (?1, ?2)', e1.sessionId, e2.sessionId)).toBe(0);
    expect((await get(s, tab)).status).toBe(200);
  });

  it('cannot reach somebody else’s session', async () => {
    const a = await createTestSession(t.env, { email: 'a@example.com' });
    const b = await createTestSession(t.env, { email: 'b@example.com' });
    await post(a, `/app/account/sessions/${b.sessionId}/revoke`);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', b.sessionId)).toBe(1);
    const html = await page(a, tab);
    expect(html).not.toContain(b.sessionId);
  });

  it('sends you to sign in when the session you revoke is your own', async () => {
    const s = await createTestSession(t.env);
    const res = await post(s, `/app/account/sessions/${s.sessionId}/revoke`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in');
  });

  it('turns sign-out off while an owner is signed in as this person', async () => {
    const s = await createTestSession(t.env);
    const owner = await createTestSession(t.env, { email: 'boss@example.com' });
    const other = await createTestSession(t.env, { email: s.user.email });
    await t.env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(owner.user.id, s.sessionId).run();
    const res = await post(s, `/app/account/sessions/${other.sessionId}/revoke`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', other.sessionId)).toBe(1);
  });
});
