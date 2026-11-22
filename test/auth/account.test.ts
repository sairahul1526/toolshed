import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/auth/config';
import { getAccount, regenerateRecoveryCodes, removePassword, revokeOtherSessions, setPassword, setUsername, startTwoStep, confirmTwoStep, turnOffTwoStep } from '../../src/auth/service';
import { sessionCookieName } from '../../src/auth/session';
import type { Env } from '../../src/env';
import { secretFromUri, totp } from '../e2e/helpers/totp';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, ORIGIN, signInByCode, testApp } from './browser';
import { codeOf, must } from './harness';

const EMAIL = 'ada@example.com';
const PASSWORD = 'correct horse battery';
const app = testApp();
const SESSION = sessionCookieName(ORIGIN);

let env: Env;
let userId: string;
let b: Browser;

const count = async (sql: string, ...binds: unknown[]) => Number(await env.DB.prepare(sql).bind(...binds).first<number>('n'));
const audits = (action: string) => count('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);
const makeStale = () => env.DB.prepare('UPDATE "session" SET "createdAt" = ?1').bind(new Date(Date.now() - 31 * 60_000).toISOString()).run();

async function signInByPassword(browser: Browser, identifier: string, password: string): Promise<Response> {
  await browser.post('/sign-in', { email: '', intent: 'password' });
  return browser.post('/sign-in/password', { identifier, password });
}

beforeEach(async () => {
  const t = createTestEnv();
  env = t.env;
  const seeded = await createTestSession(env, { email: EMAIL, name: 'Ada', instanceOwner: true });
  userId = seeded.user.id;
  b = adopt(new Browser(app, env), seeded.cookie);
});

describe('who may change an account', () => {
  it('needs a signed-in person', async () => {
    expect(await codeOf(env, new Browser(app, env), (c) => getAccount(c))).toBe('unauthorized');
    expect(await codeOf(env, new Browser(app, env), (c) => setPassword(c, { password: PASSWORD }))).toBe('unauthorized');
  });

  it('asks for a recent sign-in before changing how the account signs in', async () => {
    expect((await must(env, b, (c) => getAccount(c))).fresh).toBe(true);
    await makeStale();
    expect((await must(env, b, (c) => getAccount(c))).fresh).toBe(false);
    expect(await codeOf(env, b, (c) => setPassword(c, { password: PASSWORD }))).toBe('auth.sign_in_again');
    expect(await codeOf(env, b, (c) => removePassword(c))).toBe('auth.sign_in_again');
    expect(await codeOf(env, b, (c) => startTwoStep(c))).toBe('auth.sign_in_again');
    expect(await codeOf(env, b, (c) => turnOffTwoStep(c))).toBe('auth.sign_in_again');
    expect(await codeOf(env, b, (c) => regenerateRecoveryCodes(c))).toBe('auth.sign_in_again');
    expect(await count('SELECT COUNT(*) AS n FROM "account"')).toBe(0);
  });

  it('refuses the owner signed in as someone else', async () => {
    const owner = await createTestSession(env, { email: 'install-owner@example.com', instanceOwner: true, orgId: 'org_install' });
    await env.DB.prepare('UPDATE "session" SET "impersonatedBy" = ?1').bind(owner.user.id).run();
    expect(await codeOf(env, b, (c) => setPassword(c, { password: PASSWORD }))).toBe('auth.impersonating');
    expect(await codeOf(env, b, (c) => setUsername(c, { username: 'ada' }))).toBe('auth.impersonating');
    expect(await codeOf(env, b, (c) => startTwoStep(c))).toBe('auth.impersonating');
  });
});

describe('passwords', () => {
  it('sets a password, signs the other devices out, and signs in with it', async () => {
    const other = await createTestSession(env, { email: EMAIL });
    expect((await must(env, b, (c) => getAccount(c))).hasPassword).toBe(false);
    expect(await must(env, b, (c) => setPassword(c, { password: PASSWORD }))).toEqual({ replaced: false });
    expect((await must(env, b, (c) => getAccount(c))).hasPassword).toBe(true);
    expect(await count('SELECT COUNT(*) AS n FROM "session" WHERE "id" = ?1', other.sessionId)).toBe(0);
    expect(await audits('password.added')).toBe(1);

    const stored = await env.DB.prepare('SELECT "password" FROM "account"').first<string>('password');
    expect(stored).toMatch(/^pbkdf2-sha256\$/);
    expect(stored).not.toContain(PASSWORD);

    const fresh = new Browser(app, env);
    const done = await signInByPassword(fresh, EMAIL, PASSWORD);
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/app');
    expect(await fresh.signedIn()).toBe(true);
  });

  it('gives one answer for a wrong password, an unknown account and an account with no password', async () => {
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    await createTestSession(env, { email: 'nopass@example.com' });
    const bodies: string[] = [];
    for (const [who, pw] of [
      [EMAIL, 'wrong password 1'],
      ['nobody@example.com', PASSWORD],
      ['nopass@example.com', PASSWORD],
      ['no_such_name', PASSWORD],
    ] as const) {
      const fresh = new Browser(app, env);
      const res = await signInByPassword(fresh, who, pw);
      expect(res.status).toBe(400);
      expect(fresh.cookies.has(SESSION)).toBe(false);
      bodies.push((await res.text()).replaceAll(who, 'WHO'));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).toContain('That email or password isn’t right.');
  });

  it('enforces the length limits when setting and when signing in', async () => {
    expect(await codeOf(env, b, (c) => setPassword(c, { password: 'short' }))).toBe('auth.password_weak');
    expect(await codeOf(env, b, (c) => setPassword(c, { password: 'x'.repeat(257) }))).toBe('auth.password_too_long');
    expect(await must(env, b, (c) => setPassword(c, { password: 'x'.repeat(256) }))).toEqual({ replaced: false });

    const fresh = new Browser(app, env);
    expect((await signInByPassword(fresh, EMAIL, 'x'.repeat(300))).status).toBe(400);
    expect((await signInByPassword(fresh, EMAIL, 'x'.repeat(5000))).status).toBe(422);
    expect((await signInByPassword(fresh, EMAIL, 'x'.repeat(256))).status).toBe(303);
  });

  it('replaces and removes a password', async () => {
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    expect(await must(env, b, (c) => setPassword(c, { password: 'another long password' }))).toEqual({ replaced: true });
    expect(await count('SELECT COUNT(*) AS n FROM "account"')).toBe(1);
    expect((await signInByPassword(new Browser(app, env), EMAIL, PASSWORD)).status).toBe(400);
    expect((await signInByPassword(new Browser(app, env), EMAIL, 'another long password')).status).toBe(303);

    await must(env, b, (c) => removePassword(c));
    expect(await count('SELECT COUNT(*) AS n FROM "account"')).toBe(0);
    expect((await signInByPassword(new Browser(app, env), EMAIL, 'another long password')).status).toBe(400);
    expect(await audits('password.changed')).toBe(1);
    expect(await audits('password.removed')).toBe(1);
  });

  it('pauses password sign-in for an account after too many tries', async () => {
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    const fresh = new Browser(app, env);
    for (let i = 0; i < LIMITS.passwordPerAccount.limit; i++) expect((await signInByPassword(fresh, EMAIL, 'wrong password 1')).status).toBe(400);
    const over = await signInByPassword(fresh, EMAIL, PASSWORD);
    expect(over.headers.get('location')).toBe('/sign-in/limited');
    expect((await fresh.get('/sign-in/limited')).status).toBe(429);
    expect(await audits('user.sign_in_paused')).toBe(1);
    // An emailed code still works, so the real owner is never locked out by a guesser.
    expect((await signInByCode(new Browser(app, env), env, EMAIL)).status).toBe(303);
  });
});

describe('usernames', () => {
  it('sets a username and signs in with it', async () => {
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    expect(await must(env, b, (c) => setUsername(c, { username: ' Ada.L ' }))).toEqual({ username: 'ada.l' });
    expect((await must(env, b, (c) => getAccount(c))).username).toBe('ada.l');
    const fresh = new Browser(app, env);
    expect((await signInByPassword(fresh, 'Ada.L', PASSWORD)).status).toBe(303);
    expect(await fresh.signedIn()).toBe(true);
  });

  it('refuses a taken or malformed username, and clears one', async () => {
    const other = adopt(new Browser(app, env), (await createTestSession(env, { email: 'bob@example.com' })).cookie);
    await must(env, other, (c) => setPassword(c, { password: PASSWORD }));
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    await must(env, other, (c) => setUsername(c, { username: 'bob' }));
    expect(await codeOf(env, b, (c) => setUsername(c, { username: 'BOB' }))).toBe('auth.username_taken');
    for (const bad of ['ab', 'has space', 'ada@example.com', 'x'.repeat(31), 'dash-ed']) {
      expect(await codeOf(env, b, (c) => setUsername(c, { username: bad }))).toBe('validation_failed');
    }
    expect(await must(env, other, (c) => setUsername(c, { username: null }))).toEqual({ username: null });
    expect(await must(env, b, (c) => setUsername(c, { username: 'bob' }))).toEqual({ username: 'bob' });
  });

  it('only exists together with a password', async () => {
    expect(await codeOf(env, b, (c) => setUsername(c, { username: 'ada' }))).toBe('auth.username_needs_password');
    expect((await must(env, b, (c) => getAccount(c))).username).toBeNull();
    expect(await audits('username.changed')).toBe(0);

    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    await must(env, b, (c) => setUsername(c, { username: 'ada' }));
    await must(env, b, (c) => removePassword(c));
    expect((await must(env, b, (c) => getAccount(c))).username).toBeNull();
    // The name is free again, and signing in with it fails like any name nobody has.
    const fresh = new Browser(app, env);
    expect((await signInByPassword(fresh, 'ada', PASSWORD)).status).toBe(400);
    expect(await fresh.signedIn()).toBe(false);
  });
});

describe('two-step sign-in', () => {
  async function enrol(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const setup = await must(env, b, (c) => startTwoStep(c));
    expect(setup.secret).toBe(secretFromUri(setup.uri));
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Toolshed/);
    expect(setup.qrSvg).toMatch(/^<svg/);
    expect(setup.recoveryCodes).toHaveLength(10);
    await must(env, b, (c) => confirmTwoStep(c, { code: totp(setup.secret) }));
    return setup;
  }

  /** First step done by emailed code; the browser is left on the two-step page. */
  async function upToSecondStep(browser: Browser): Promise<void> {
    const res = await signInByCode(browser, env, EMAIL);
    expect(res.headers.get('location')).toBe('/sign-in/two-step');
    expect(browser.cookies.has(SESSION)).toBe(false);
    expect((await browser.get('/sign-in/two-step')).status).toBe(200);
  }

  it('does not change sign-in until the app has proved it works', async () => {
    await must(env, b, (c) => startTwoStep(c));
    expect((await must(env, b, (c) => getAccount(c))).twoStep).toBe(false);
    expect(await codeOf(env, b, (c) => confirmTwoStep(c, { code: '000000' }))).toBe('auth.two_step_wrong');
    const fresh = new Browser(app, env);
    expect((await signInByCode(fresh, env, EMAIL)).headers.get('location')).toBe('/app');
  });

  it('turns on, keeps the browser signed in, and stores the secret encrypted', async () => {
    const { secret } = await enrol();
    expect((await must(env, b, (c) => getAccount(c))).twoStep).toBe(true);
    expect(await b.signedIn()).toBe(true);
    expect(await audits('two_step.turned_on')).toBe(1);
    const row = await env.DB.prepare('SELECT "secret", "backupCodes" FROM "twoFactor"').first<{ secret: string; backupCodes: string }>();
    expect(row?.secret).not.toContain(secret);
    expect(await codeOf(env, b, (c) => startTwoStep(c))).toBe('auth.two_step_on');
  });

  it('asks for the authenticator code after the first step', async () => {
    const { secret } = await enrol();
    const fresh = new Browser(app, env);
    await upToSecondStep(fresh);

    const wrong = await fresh.post('/sign-in/two-step', { code: '000000' });
    expect(wrong.status).toBe(400);
    expect(fresh.cookies.has(SESSION)).toBe(false);

    const done = await fresh.post('/sign-in/two-step', { code: totp(secret) });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/app');
    expect(await fresh.signedIn()).toBe(true);
  });

  it('cannot be skipped by going straight to the app or by the emailed link', async () => {
    await enrol();
    const fresh = new Browser(app, env);
    await upToSecondStep(fresh);
    expect(await fresh.signedIn()).toBe(false);
    expect((await new Browser(app, env).post('/sign-in/two-step', { code: '123456' })).headers.get('location')).toBe('/sign-in');
  });

  it('accepts each recovery code once', async () => {
    const { recoveryCodes } = await enrol();
    const code = recoveryCodes[0]!;
    const first = new Browser(app, env);
    await upToSecondStep(first);
    expect((await first.get('/sign-in/recovery')).status).toBe(200);
    const done = await first.post('/sign-in/recovery', { code });
    expect(done.status).toBe(303);
    expect(await first.signedIn()).toBe(true);

    const second = new Browser(app, env);
    await upToSecondStep(second);
    const again = await second.post('/sign-in/recovery', { code });
    expect(again.status).toBe(400);
    expect(second.cookies.has(SESSION)).toBe(false);
  });

  it('skips the second step on a trusted device only', async () => {
    const { secret } = await enrol();
    const laptop = new Browser(app, env);
    await upToSecondStep(laptop);
    await laptop.post('/sign-in/two-step', { code: totp(secret), trust: 'yes' });
    await laptop.post('/sign-out');

    expect((await signInByCode(laptop, env, EMAIL)).headers.get('location')).toBe('/app');
    expect((await signInByCode(new Browser(app, env), env, EMAIL)).headers.get('location')).toBe('/sign-in/two-step');
  });

  /** A second browser that passed the check once, asked to be trusted, and now gets in on the first step alone. */
  async function trustedLaptop(secret: string): Promise<Browser> {
    const laptop = new Browser(app, env);
    await upToSecondStep(laptop);
    await laptop.post('/sign-in/two-step', { code: totp(secret), trust: 'yes' });
    await laptop.post('/sign-out');
    expect((await signInByCode(laptop, env, EMAIL)).headers.get('location')).toBe('/app');
    await laptop.post('/sign-out');
    return laptop;
  }
  const trusted = () => count(`SELECT COUNT(*) AS n FROM "verification" WHERE "identifier" LIKE 'trust-device-%'`);

  it.each([
    ['the other devices are signed out', async () => void (await must(env, b, (c) => revokeOtherSessions(c)))],
    ['a password is set', async () => void (await must(env, b, (c) => setPassword(c, { password: PASSWORD })))],
    ['new recovery codes are made', async () => void (await must(env, b, (c) => regenerateRecoveryCodes(c)))],
  ])('asks a trusted device for the code again once %s', async (_what, change) => {
    const { secret } = await enrol();
    const laptop = await trustedLaptop(secret);
    expect(await trusted()).toBe(1);
    await change();
    expect(await trusted()).toBe(0);
    expect((await signInByCode(laptop, env, EMAIL)).headers.get('location')).toBe('/sign-in/two-step');
  });

  it('does not let a device trusted before two-step was turned off skip it when it is turned on again', async () => {
    const laptop = await trustedLaptop((await enrol()).secret);
    await must(env, b, (c) => turnOffTwoStep(c));
    expect(await trusted()).toBe(0);
    await enrol();
    expect((await signInByCode(laptop, env, EMAIL)).headers.get('location')).toBe('/sign-in/two-step');
  });

  it('leaves another person’s trusted devices alone', async () => {
    const { secret } = await enrol();
    await trustedLaptop(secret);
    const other = await createTestSession(env, { email: 'grace@example.com' });
    await must(env, adopt(new Browser(app, env), other.cookie), (c) => revokeOtherSessions(c));
    expect(await trusted()).toBe(1);
  });

  it('makes new recovery codes and turns off', async () => {
    const { recoveryCodes } = await enrol();
    const fresh = await must(env, b, (c) => regenerateRecoveryCodes(c));
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toEqual(recoveryCodes);

    const old = new Browser(app, env);
    await upToSecondStep(old);
    expect((await old.post('/sign-in/recovery', { code: recoveryCodes[1]! })).status).toBe(400);

    await must(env, b, (c) => turnOffTwoStep(c));
    expect((await must(env, b, (c) => getAccount(c))).twoStep).toBe(false);
    expect(await count('SELECT COUNT(*) AS n FROM "twoFactor"')).toBe(0);
    expect(await codeOf(env, b, (c) => regenerateRecoveryCodes(c))).toBe('auth.two_step_off');
    expect((await signInByCode(new Browser(app, env), env, EMAIL)).headers.get('location')).toBe('/app');
    expect(await audits('two_step.turned_off')).toBe(1);
  });

  it('needs the current password from an account that has one', async () => {
    await must(env, b, (c) => setPassword(c, { password: PASSWORD }));
    expect(await codeOf(env, b, (c) => startTwoStep(c))).toBe('auth.password_wrong');
    expect(await codeOf(env, b, (c) => startTwoStep(c, { password: 'not the password' }))).toBe('auth.password_wrong');
    const setup = await must(env, b, (c) => startTwoStep(c, { password: PASSWORD }));
    await must(env, b, (c) => confirmTwoStep(c, { code: totp(setup.secret) }));

    const fresh = new Browser(app, env);
    await fresh.post('/sign-in', { email: '', intent: 'password' });
    const first = await fresh.post('/sign-in/password', { identifier: EMAIL, password: PASSWORD });
    expect(first.headers.get('location')).toBe('/sign-in/two-step');
    expect(fresh.cookies.has(SESSION)).toBe(false);
    expect((await fresh.post('/sign-in/two-step', { code: totp(setup.secret) })).headers.get('location')).toBe('/app');
  });
});
