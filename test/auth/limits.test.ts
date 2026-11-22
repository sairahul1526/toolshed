/**
 * The limits a stranger runs into. The per-address and per-account ones are tested beside the
 * flows they protect; these are the per-IP ones, and the rule that only local development is looser.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../src/auth/config';
import { addressBlock, hit } from '../../src/auth/http';
import { sendEmail } from '../../src/core/email';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { Browser, lastCode, testApp } from './browser';

const EMAIL = 'ada@example.com';
const app = testApp();

let env: Env;

const sessions = async () => Number(await env.DB.prepare('SELECT COUNT(*) AS n FROM "session"').first<number>('n'));
const fill = async (name: keyof typeof LIMITS, who: string, on = env) => {
  for (let i = 0; i < LIMITS[name].limit; i++) expect(await hit(on, name, who)).toBe(0);
};

beforeEach(async () => {
  env = createTestEnv().env;
  await createTestSession(env, { email: EMAIL });
  await env.DB.prepare('DELETE FROM "session"').run();
});

describe('limits per IP address', () => {
  it('stops one machine asking for codes for address after address', async () => {
    const noisy = '198.51.100.99';
    await fill('codePerIp', noisy);
    const b = new Browser(app, env, noisy);
    const res = await b.post('/sign-in', { email: 'someone-new@example.com', intent: 'code' });
    expect(res.headers.get('location')).toBe('/sign-in/limited');
    const paused = await b.get('/sign-in/limited');
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain('Too many tries');
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_codes').first<number>('n')).toBe(0);

    // Someone else, somewhere else, is not held up by it.
    const other = new Browser(app, env, '198.51.100.7');
    expect((await other.post('/sign-in', { email: EMAIL, intent: 'code' })).headers.get('location')).toBe('/sign-in/code');
  });

  it('stops one machine checking code after code, even with the right one', async () => {
    const noisy = '198.51.100.99';
    const b = new Browser(app, env, noisy);
    await b.post('/sign-in', { email: EMAIL, intent: 'code' });
    const code = await lastCode(env, EMAIL);
    await fill('checkPerIp', noisy);

    expect((await b.post('/sign-in/code', { code })).headers.get('location')).toBe('/sign-in/limited');
    expect(await sessions()).toBe(0);
    // The refused check did not use the code up.
    expect(await env.DB.prepare('SELECT attempts FROM auth_codes').first<number>('attempts')).toBe(0);
  });

  it('stops one machine hammering passkey sign-in', async () => {
    const noisy = '198.51.100.99';
    await fill('passkeyPerIp', noisy);
    const res = await new Browser(app, env, noisy).get('/api/auth/passkey/sign-in-options', { accept: 'application/json' });
    expect(res.status).toBe(429);
    expect(JSON.stringify(await res.json())).toContain('rate_limited');
    expect((await new Browser(app, env, '198.51.100.7').get('/api/auth/passkey/sign-in-options', { accept: 'application/json' })).status).toBe(200);
  });
});

describe('a caller with a whole IPv6 network to pick addresses from', () => {
  it('is counted as one caller across its /64, however each address is written', () => {
    expect(addressBlock('2001:db8:1:2::1')).toBe('2001:db8:1:2::/64');
    expect(addressBlock('2001:0DB8:0001:0002:aaaa:bbbb:cccc:dddd')).toBe('2001:db8:1:2::/64');
    expect(addressBlock('2001:db8:1:2:ffff::')).toBe('2001:db8:1:2::/64');
    expect(addressBlock('::1')).toBe('0:0:0:0::/64');
    expect(addressBlock('2001:db8:1:3::1')).toBe('2001:db8:1:3::/64');
  });

  it('leaves IPv4 and anything it cannot read as they are', () => {
    for (const same of ['198.51.100.7', '::ffff:198.51.100.7', 'local', '2001:db8::1::2', '1:2:3:4:5:6:7:8:9', 'fe80::1%eth0', '2001:db8:zz::1', '']) {
      expect(addressBlock(same), same).toBe(same);
    }
  });

  it('runs out of tries as a network, not address by address', async () => {
    // One fixed moment, so the tries cannot fall either side of a window's edge.
    const now = Date.UTC(2026, 0, 5, 12, 0, 10);
    for (let i = 0; i < LIMITS.bearerPerIp.limit; i++) expect(await hit(env, 'bearerPerIp', `2001:db8:1:2::${(i + 1).toString(16)}`, now)).toBe(0);
    expect(await hit(env, 'bearerPerIp', '2001:db8:1:2:9999:8888:7777:6666', now)).toBeGreaterThan(0);
    expect(await hit(env, 'bearerPerIp', '2001:db8:1:3::1', now)).toBe(0);
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'auth.bearerPerIp:2001:db8:1:2:%'`).first<number>('n')).toBe(1);
  });

  it('does not fold accounts together: only the per-address limits count by network', async () => {
    await fill('codePerEmail', '2001:db8:1:2::1');
    expect(await hit(env, 'codePerEmail', '2001:db8:1:2::2')).toBe(0);
  });
});

describe('a machine past its limit, typing a new name each time', () => {
  const count = async (sql: string) => Number(await env.DB.prepare(sql).first<number>('n'));

  it('leaves one audit line for the address and nothing under the names', async () => {
    const noisy = '198.51.100.99';
    await fill('checkPerIp', noisy);
    const countersBefore = await count('SELECT COUNT(*) AS n FROM rate_limits');

    const b = new Browser(app, env, noisy);
    for (let i = 0; i < 25; i++) {
      const res = await b.post('/sign-in/password', { identifier: `made-up-${i}@example.com`, password: 'a long wrong password' });
      expect(res.headers.get('location')).toBe('/sign-in/limited');
    }

    const lines = (await env.DB.prepare(`SELECT actor_label, summary, meta, ip FROM audit_log WHERE action = 'user.sign_in_paused'`).all<Record<string, string | null>>()).results;
    expect(lines).toEqual([{ actor_label: null, summary: 'Too many sign-in tries from one address', meta: '{"what":"address"}', ip: noisy }]);
    // One new counter, for the address. None per name.
    expect((await count('SELECT COUNT(*) AS n FROM rate_limits')) - countersBefore).toBe(1);
    expect(await count(`SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'auth.passwordPerAccount:%' OR key LIKE 'auth.burst:password:%'`)).toBe(0);
  });

  it('still notes an account that was paused by its own limit', async () => {
    const b = new Browser(app, env);
    for (let i = 0; i <= LIMITS.passwordPerAccount.limit; i++) await b.post('/sign-in/password', { identifier: EMAIL, password: 'a long wrong password' });
    const lines = (await env.DB.prepare(`SELECT actor_label, meta FROM audit_log WHERE action = 'user.sign_in_paused'`).all<Record<string, string | null>>()).results;
    expect(lines).toEqual([{ actor_label: EMAIL, meta: '{"what":"password"}' }]);
  });
});

describe('emails from the rest of the install', () => {
  it('cannot use up the room a sign-in code needs', async () => {
    const sent: string[] = [];
    const binding = { send: async (m: { subject: string }) => (sent.push(m.subject), { messageId: 'cf_1' }) };
    const live = createTestEnv({ ENVIRONMENT: 'production', EMAIL: binding as never, EMAIL_FROM: 'hello@mail.example.com' }).env;
    await createTestSession(live, { email: EMAIL });
    // A public form, say, that writes to this address until the hourly cap stops it.
    let last = '';
    for (let i = 0; i < 12; i++) last = (await sendEmail(live, { to: EMAIL, subject: 'Hello', html: '<p>hello</p>', text: 'hello', template: 'test' })).status;
    expect(last).toBe('capped');
    sent.length = 0;

    const b = new Browser(app, live);
    expect((await b.post('/sign-in', { email: EMAIL, intent: 'code' })).headers.get('location')).toBe('/sign-in/code');
    expect(sent).toHaveLength(1);
    expect(await live.DB.prepare(`SELECT status FROM email_log WHERE template = 'sign-in-code'`).first<string>('status')).toBe('sent');
  });
});

describe('how strict the limits are', () => {
  it('is the same everywhere except local development', async () => {
    for (const mode of ['production', 'test'] as const) {
      const strict = createTestEnv({ ENVIRONMENT: mode }).env;
      await fill('codePerEmail', 'who', strict);
      expect(await hit(strict, 'codePerEmail', 'who')).toBeGreaterThan(0);
    }
    const dev = createTestEnv({ ENVIRONMENT: 'dev' }).env;
    await fill('codePerEmail', 'who', dev);
    expect(await hit(dev, 'codePerEmail', 'who')).toBe(0);
  });

  it('says how long to wait, and counts each name and each person apart', async () => {
    await fill('codePerEmail', 'ada');
    const wait = await hit(env, 'codePerEmail', 'ada');
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(LIMITS.codePerEmail.windowSec);
    expect(await hit(env, 'codePerEmail', 'bob')).toBe(0);
    expect(await hit(env, 'emailChangePerAddress', 'ada')).toBe(0);
  });
});
