/**
 * KV cache for the redirect hot path. One read per visit; a write only when a code is not cached yet.
 * Entries expire on their own, and every edit deletes the entry so changes show up at once.
 */
import type { Env } from '../../env';

export const LINK_TTL_SEC = 6 * 60 * 60;
export const PAGE_TTL_SEC = 60 * 60;

export const linkKey = (code: string): string => `links:r:${code}`;
export const pageKey = (code: string): string => `links:p:${code}`;

/** Forget a code's cached redirect record and cached bio page. Never throws: the entry expires anyway. */
export async function bust(env: Env, ...codes: string[]): Promise<void> {
  const keys = codes.flatMap((c) => [linkKey(c), pageKey(c)]);
  await Promise.all(keys.map((k) => env.KV.delete(k).catch(() => undefined)));
}

export async function putCached(env: Env, key: string, value: string, ttl: number): Promise<void> {
  try {
    await env.KV.put(key, value, { expirationTtl: ttl });
  } catch {
    // The free plan allows 1,000 KV writes a day. When it runs out, visits still work from the database.
  }
}
