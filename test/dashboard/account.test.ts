import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import account from '../../src/dashboard/account';
import overview from '../../src/dashboard/overview';
import { lastCode } from '../auth/browser';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const app = createApp({ screens: { overview, account } });

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});

const get = (s: TestSession, path = '/app/account') => app.request(path, { headers: s.headers }, t.env);
const post = (s: TestSession, path: string, fields: Record<string, string> = {}) =>
  app.request(path, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, t.env);
const page = async (s: TestSession, path?: string) => (await get(s, path)).text();
const makeStale = () => t.env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();
const audits = async (action: string) => Number(await t.env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1').bind(action).first<number>('n'));
const userRow = (id: string) => t.env.DB.prepare('SELECT "name", "email", "username" FROM "user" WHERE "id" = ?1').bind(id).first<{ name: string; email: string; username: string | null }>();

describe('who can open it', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const res = await app.request('/app/account', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it.each(['owner', 'admin', 'member', 'viewer'] as const)('shows a %s their own account with every control', async (role) => {
    const s = await createTestSession(t.env, { role, name: 'Ada Lovelace', email: 'ada@example.com' });
    const res = await get(s);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const html = await res.text();
    expect(html).toContain('ada@example.com');
    expect(html).toContain('Save name');
    expect(html).toContain('Send code');
    expect(html).toContain('Delete account');
    expect(html).not.toContain('Sign in again to change');
  });

  it.each([
    ['', 'Save name'],
    ['?tab=account', 'Save name'],
    ['?tab=security', 'Two-step sign-in'],
    ['?tab=sessions', 'Where you are signed in'],
    ['?tab=nonsense', 'Save name'],
  ])('opens %s', async (query, marker) => {
    const s = await createTestSession(t.env);
    expect(await page(s, `/app/account${query}`)).toContain(marker);
  });

  it('marks the open tab and links all three', async () => {
    const s = await createTestSession(t.env);
    const html = await page(s, '/app/account?tab=security');
    expect(html).toMatch(/<a href="\/app\/account\?tab=security" aria-current="page"/);
    expect(html).toContain('href="/app/account?tab=sessions"');
  });

  it('refuses a post from another site', async () => {
    const s = await createTestSession(t.env);
    const res = await app.request('/app/account/name', { method: 'POST', headers: { cookie: s.cookie, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Mallory' }, t.env);
    expect(res.status).toBe(403);
    expect((await userRow(s.user.id))?.name).toBe(s.user.name);
  });
});

describe('name', () => {
  it('saves and says so', async () => {
    const s = await createTestSession(t.env);
    const res = await post(s, '/app/account/name', { name: '  Grace Hopper ' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/account');
    expect((await userRow(s.user.id))?.name).toBe('Grace Hopper');
    expect(await audits('user.renamed')).toBe(1);
  });

  it('shows a refusal under the field and keeps what was typed', async () => {
    const s = await createTestSession(t.env);
    const res = await post(s, '/app/account/name', { name: '   ' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('id="name-error"');
    expect((await userRow(s.user.id))?.name).toBe(s.user.name);
  });

  it('escapes a hostile name everywhere it is shown', async () => {
    const s = await createTestSession(t.env);
    const evil = '<script>alert(1)</script>"><img src=x onerror=alert(2)>';
    await post(s, '/app/account/name', { name: evil });
    for (const path of ['/app/account', '/app/account?tab=security']) {
      const html = await page(s, path);
      expect(html).not.toContain('<script>alert(1)');
      expect(html).not.toContain('<img src=x');
    }
  });

  it('never changes another person', async () => {
    const a = await createTestSession(t.env, { email: 'a@example.com', name: 'Aa' });
    const b = await createTestSession(t.env, { email: 'b@example.com', name: 'Bb' });
    await post(a, '/app/account/name', { name: 'Changed', id: b.user.id, userId: b.user.id });
    expect((await userRow(b.user.id))?.name).toBe('Bb');
    expect((await userRow(a.user.id))?.name).toBe('Changed');
  });
});

describe('username', () => {
  it('needs a password first, and says where to set one', async () => {
    const s = await createTestSession(t.env);
    const html = await page(s);
    expect(html).toContain('needs a password');
    const res = await post(s, '/app/account/username', { username: 'ada' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await userRow(s.user.id))?.username).toBeNull();
  });

  it('is set, changed and removed once there is a password', async () => {
    const s = await createTestSession(t.env);
    await post(s, '/app/account/password', { password: 'a long enough password' });
    expect((await post(s, '/app/account/username', { username: 'ada_l' })).status).toBe(303);
    expect((await userRow(s.user.id))?.username).toBe('ada_l');
    expect((await post(s, '/app/account/username', { username: '' })).status).toBe(303);
    expect((await userRow(s.user.id))?.username).toBeNull();
  });

  it('shows invalid and taken usernames under the field', async () => {
    const a = await createTestSession(t.env, { email: 'a@example.com' });
    const b = await createTestSession(t.env, { email: 'b@example.com' });
    await post(a, '/app/account/password', { password: 'a long enough password' });
    await post(b, '/app/account/password', { password: 'a long enough password' });
    await post(a, '/app/account/username', { username: 'taken_name' });
    const bad = await post(b, '/app/account/username', { username: 'No Spaces!' });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('id="username-error"');
    const taken = await post(b, '/app/account/username', { username: 'taken_name' });
    expect(await taken.text()).toContain('id="username-error"');
    expect((await userRow(b.user.id))?.username).toBeNull();
  });
});

describe('email', () => {
  it('asks for a code, then switches only after the right one', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    const start = await post(s, '/app/account/email/start', { email: 'Ada@New.example.com' });
    expect(start.status).toBe(303);
    const html = await page(s);
    expect(html).toContain('ada@new.example.com');
    expect(html).toContain('Confirm new email');
    expect((await userRow(s.user.id))?.email).toBe('ada@example.com');

    const code = await lastCode(t.env, 'ada@new.example.com');
    const wrong = await post(s, '/app/account/email/confirm', { code: code === '000000' ? '000001' : '000000' });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(await wrong.text()).toContain('id="email-code-error"');
    expect((await userRow(s.user.id))?.email).toBe('ada@example.com');

    expect((await post(s, '/app/account/email/confirm', { code })).status).toBe(303);
    expect((await userRow(s.user.id))?.email).toBe('ada@new.example.com');
    expect(await audits('user.email_changed')).toBe(1);
  });

  it('refuses the same address and a malformed one under the field', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    for (const email of ['ada@example.com', 'not-an-email']) {
      const res = await post(s, '/app/account/email/start', { email });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(await res.text()).toContain('id="email-error"');
    }
  });

  it('gives a taken address the same answer as a free one', async () => {
    await createTestSession(t.env, { email: 'bob@example.com' });
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    const res = await post(s, '/app/account/email/start', { email: 'bob@example.com' });
    expect(res.status).toBe(303);
    expect(await page(s)).toContain('bob@example.com');
  });

  it('cancels a pending change', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    await post(s, '/app/account/email/start', { email: 'ada@new.example.com' });
    expect((await post(s, '/app/account/email/cancel')).status).toBe(303);
    expect(await page(s)).not.toContain('Confirm new email');
  });

  it('never leaks a code into a redirect', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    const res = await post(s, '/app/account/email/start', { email: 'ada@new.example.com' });
    const code = await lastCode(t.env, 'ada@new.example.com');
    expect(`${res.headers.get('location')} ${res.headers.get('set-cookie')}`).not.toContain(code);
  });
});

describe('delete account', () => {
  it('needs the typed email, then erases the account and signs out', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com', instanceOwner: false, role: 'member' });
    const wrong = await post(s, '/app/account/delete', { confirm: 'nope' });
    expect(wrong.status).toBe(422);
    expect(await wrong.text()).toContain('id="confirm-error"');
    expect(await userRow(s.user.id)).not.toBeNull();

    const res = await post(s, '/app/account/delete', { confirm: 'ADA@example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/sign-in');
    expect(await userRow(s.user.id)).toBeNull();
    expect(await audits('user.deleted')).toBe(1);
  });

  it('lists the workspaces that block it and refuses', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com', role: 'owner' });
    const html = await page(s);
    expect(html).toContain('only owner of these workspaces');
    expect(html).toContain('Test Workspace');
    const res = await post(s, '/app/account/delete', { confirm: 'ada@example.com' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await userRow(s.user.id)).not.toBeNull();
  });
});

describe('signing in again and being watched', () => {
  it('asks for a fresh sign-in when the session is old, and changes nothing', async () => {
    const s = await createTestSession(t.env, { email: 'ada@example.com' });
    await makeStale();
    const html = await page(s);
    expect(html).toContain('Sign in again to change sign-in settings');
    expect(html).toContain('action="/api/auth/sign-out"');
    const res = await post(s, '/app/account/email/start', { email: 'ada@new.example.com' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('Sign in again first');
    expect((await userRow(s.user.id))?.email).toBe('ada@example.com');
    // A name does not need a recent sign-in.
    expect((await post(s, '/app/account/name', { name: 'Still works' })).status).toBe(303);
  });

  it('turns every change off while an owner is signed in as this person', async () => {
    const s = await createTestSession(t.env);
    const owner = await createTestSession(t.env, { email: 'boss@example.com', instanceOwner: true });
    await t.env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1 WHERE "id" = ?2').bind(owner.user.id, s.sessionId).run();
    const html = await page(s);
    expect(html).toContain('You are viewing this account as its owner');
    const res = await post(s, '/app/account/name', { name: 'Hijacked' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await userRow(s.user.id))?.name).toBe(s.user.name);
  });
});
