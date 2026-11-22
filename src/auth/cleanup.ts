/**
 * Daily tidy-up of rows nobody can use any more: email codes that ended over a day ago, sessions
 * past their end, and Better Auth's short-lived verification rows. It never changes who can sign
 * in. It stops addresses, IP addresses and browser names from being kept for ever.
 */
import { registerCoreSchedule } from '../core/jobs';
import type { Env } from '../env';
import { purgeOldCodes } from './codes';

export async function cleanupAuth(env: Env, now = Date.now()): Promise<void> {
  // Better Auth stores these times as ISO text in UTC, which sorts in time order.
  const iso = new Date(now).toISOString();
  await purgeOldCodes(env, now);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM "session" WHERE "expiresAt" < ?1').bind(iso),
    env.DB.prepare('DELETE FROM "verification" WHERE "expiresAt" < ?1').bind(iso),
  ]);
}

registerCoreSchedule({ name: 'auth-cleanup', every: 'day', run: (env, at) => cleanupAuth(env, at.getTime()) });
