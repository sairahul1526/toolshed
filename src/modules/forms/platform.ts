/**
 * Thin adapters over the shared core helpers, so the rest of Forms keeps one import and tests can
 * pass `now`. Signed tokens carry their own expiry (`x`, in ms) so a test clock is honoured.
 */
import { baseUrl, clientIp as coreClientIp, isBot as coreIsBot, visitorId } from '../../core/net';
import { parseCsv, type ParsedCsv } from '../../core/csv-parse';
import { readSignedToken as coreRead, signedToken as coreSign } from '../../core/signing';
import type { Env } from '../../env';

export { baseUrl, parseCsv, visitorId };
export type { ParsedCsv };

export async function sha256(text: string): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...raw].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The caller's address for rate limits only. Empty when unknown. Never stored. */
export function clientIp(req: Request): string {
  return coreClientIp(req) ?? '';
}

export function isBot(req: Request): boolean {
  return coreIsBot(req.headers.get('user-agent'));
}

export function signedToken(env: Env, purpose: string, payload: Record<string, unknown>, ttlSec = 86_400, now = Date.now()): Promise<string> {
  return coreSign(env, purpose, { ...payload, x: now + ttlSec * 1000 });
}

export async function readSignedToken(env: Env, purpose: string, token: string, now = Date.now()): Promise<Record<string, unknown> | null> {
  const data = await coreRead(env, purpose, token, now);
  if (!data || typeof data.x !== 'number' || data.x <= now) return null;
  return data;
}
