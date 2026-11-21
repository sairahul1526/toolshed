/**
 * Rate limits. Fixed windows counted in D1, so a limit holds across every Worker instance.
 * Use for sign-in tries, public form posts, API calls: anything a stranger can repeat.
 */
import type { Env } from '../env';
import { AppError } from './errors';

export interface RateLimitRule {
  /** How many are allowed per window. */
  limit: number;
  /** Window length in seconds. */
  windowSec: number;
}

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * Count one hit against `key` and say whether it is within the limit.
 * Build keys as `<what>:<who>`, for example `signin:ip:203.0.113.9` or `forms.submit:frm_123:203.0.113.9`.
 */
export async function rateLimit(env: Env, key: string, rule: RateLimitRule, now = Date.now()): Promise<RateLimitResult> {
  const windowMs = rule.windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1
     RETURNING count`,
  )
    .bind(key, windowStart)
    .first<{ count: number }>();
  const count = row?.count ?? 1;
  return {
    ok: count <= rule.limit,
    remaining: Math.max(0, rule.limit - count),
    retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)),
  };
}

/** Like `rateLimit`, but throws the `rate_limited` error (HTTP 429 with Retry-After) when over. */
export async function enforceRateLimit(env: Env, key: string, rule: RateLimitRule, message?: string): Promise<void> {
  const res = await rateLimit(env, key, rule);
  if (res.ok) return;
  const wait = res.retryAfter >= 90 ? `${Math.ceil(res.retryAfter / 60)} minutes` : `${res.retryAfter} seconds`;
  throw new AppError('rate_limited', 429, message ?? `Too many tries. Try again in ${wait}.`, undefined, {
    'Retry-After': String(res.retryAfter),
  });
}

/** Delete counters for windows that ended more than a day ago. Run by the daily schedule. */
export async function cleanupRateLimits(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?1')
    .bind(now - 24 * 60 * 60 * 1000)
    .run();
}
