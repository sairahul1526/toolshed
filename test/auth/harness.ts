/**
 * Runs one service function the way a route would: inside a real request that went through
 * `loadAuth`, with the browser's cookies. Returns the value, or the stable error it threw.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { loadAuth } from '../../src/auth/load';
import { AppError } from '../../src/core/errors';
import type { AppEnv, Env } from '../../src/env';
import { ORIGIN, type Browser } from './browser';

export type Outcome<T> = { ok: true; value: T } | { ok: false; code: string; status: number; message: string };

export async function run<T>(env: Env, who: Browser | Record<string, string>, fn: (c: Context<AppEnv>) => Promise<T>): Promise<Outcome<T>> {
  const app = new Hono<AppEnv>();
  let outcome: Outcome<T> | undefined;
  app.use('*', async (c, next) => {
    c.set('requestId', 'req_test');
    c.set('user', null);
    c.set('org', null);
    c.set('auth', { kind: 'anon', scopes: [] });
    await next();
  });
  app.use('*', loadAuth);
  app.post('/run', async (c) => {
    try {
      outcome = { ok: true, value: await fn(c) };
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      outcome = { ok: false, code: err.code, status: err.status, message: err.message };
    }
    return c.body(null, 204);
  });
  const headers = 'headers' in who && typeof who.headers === 'function' ? (who as Browser).headers({ origin: ORIGIN }) : (who as Record<string, string>);
  const res = await app.request('/run', { method: 'POST', headers }, env);
  if ('absorb' in who && typeof who.absorb === 'function') (who as Browser).absorb(res);
  if (!outcome) throw new Error(`The service call did not finish (HTTP ${res.status}): ${await res.text()}`);
  return outcome;
}

/** The value of a call that must succeed. */
export async function must<T>(env: Env, who: Browser | Record<string, string>, fn: (c: Context<AppEnv>) => Promise<T>): Promise<T> {
  const outcome = await run(env, who, fn);
  if (!outcome.ok) throw new Error(`Expected success, got ${outcome.code}: ${outcome.message}`);
  return outcome.value;
}

/** The error code of a call that must fail. */
export async function codeOf(env: Env, who: Browser | Record<string, string>, fn: (c: Context<AppEnv>) => Promise<unknown>): Promise<string> {
  const outcome = await run(env, who, fn);
  if (outcome.ok) throw new Error('Expected an error, but the call succeeded.');
  return outcome.code;
}
