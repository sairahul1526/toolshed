/**
 * Sessions, sign-in codes and flow cookies are all signed with AUTH_SECRET. An install whose secret
 * is missing or short must not sign anyone in: every page that asks "who is this?" answers with
 * the setup step instead.
 */
import { describe, expect, it } from 'vitest';
import { getAuth } from '../../src/auth/auth';
import { AppError } from '../../src/core/errors';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastEmail, ORIGIN, testApp } from './browser';

const EMAIL = 'ada@example.com';
const app = testApp();

const rows = async (env: Env, table: string) => Number(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<number>('n'));

describe('an install without a real AUTH_SECRET', () => {
  it.each([
    ['is not set', undefined],
    ['is empty', '   '],
    ['is a short word', 'too-short'],
    ['is the example value from .dev.vars.example', 'replace-with-a-long-random-string'],
    ['is one character under the minimum', 'x'.repeat(31)],
  ])('shows the setup step on the sign-in page when the secret %s', async (_label, secret) => {
    const { env } = createTestEnv({ AUTH_SECRET: secret as string });
    const res = await new Browser(app, env).get('/sign-in');
    expect(res.status).toBe(409);
    const html = await res.text();
    expect(html).toContain('Set AUTH_SECRET to a random value of at least 32 characters');
    expect(html).not.toContain('name="email"');
  });

  it('sends no code and starts no sign-in', async () => {
    const { env } = createTestEnv({ AUTH_SECRET: 'x'.repeat(31) });
    await createTestSession(env, { email: EMAIL, instanceOwner: true });
    const res = await new Browser(app, env).post('/sign-in', { email: EMAIL, intent: 'code' });
    expect(res.status).toBe(409);
    expect(await rows(env, 'auth_codes')).toBe(0);
    expect(await lastEmail(env, EMAIL)).toBeNull();
  });

  it('does not accept a session cookie signed with the weak secret, on the dashboard or the API', async () => {
    const { env } = createTestEnv({ AUTH_SECRET: 'x'.repeat(31) });
    const ada = await createTestSession(env, { email: EMAIL, role: 'owner', instanceOwner: true });
    const browser = adopt(new Browser(app, env), ada.cookie);

    expect((await browser.get('/app')).status).toBe(409);
    const api = await browser.get('/api/v1/nothing', { accept: 'application/json' });
    expect(api.status).toBe(409);
    expect(((await api.json()) as { code: string }).code).toBe('needs_setup');
    expect(await browser.signedIn()).toBe(false);
  });

  it('builds no sign-in engine for code that asks for one directly', async () => {
    const { env } = createTestEnv({ AUTH_SECRET: 'too-short' });
    const err = await getAuth(env, ORIGIN).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('needs_setup');
  });

  it('works from 32 characters up', async () => {
    const { env } = createTestEnv({ AUTH_SECRET: 'x'.repeat(32) });
    const ada = await createTestSession(env, { email: EMAIL, role: 'owner', instanceOwner: true });
    expect((await new Browser(app, env).get('/sign-in')).status).toBe(200);
    expect(await adopt(new Browser(app, env), ada.cookie).signedIn()).toBe(true);
  });
});
