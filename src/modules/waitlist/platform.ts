/**
 * The few request and signing helpers this module needs: the public base URL, a caller's address,
 * signed expiring tokens and a cookie-free visitor hash. Everything signs with the install secret.
 */
import type { Env } from '../../env';
import { clientIp as netIp } from '../../core/net';
import { readSignedToken, sign, signedToken } from '../../core/signing';

export { baseUrl } from '../../core/net';

/** The caller's address, or an empty string when the request carries none. */
export function clientIp(req: Request): string {
  return netIp(req) ?? '';
}

/** A short keyed hash of one input (an address, an email). Stable, not reversible without the secret. */
export async function keyedHash(env: Env, purpose: string, value: string): Promise<string> {
  return (await sign(env, purpose, value)).slice(0, 22);
}

/** Who is asking, as a hash of address and browser. Never stored raw and never set as a cookie. */
export async function visitorHash(env: Env, req: Request): Promise<string> {
  return keyedHash(env, 'wl-visitor', `${clientIp(req)}|${req.headers.get('user-agent') ?? ''}`);
}

/** A token holding `payload` that stops working after `ttlSec` seconds. */
export async function makeToken(env: Env, purpose: string, payload: Record<string, unknown>, ttlSec: number): Promise<string> {
  return signedToken(env, purpose, payload, ttlSec);
}

/** The payload of a token from `makeToken`, or null when it is forged, expired or for another purpose. */
export async function readToken<T extends Record<string, unknown>>(env: Env, purpose: string, token: string, now = Date.now()): Promise<T | null> {
  if (token.length > 2000) return null;
  return readSignedToken<T>(env, purpose, token, now);
}
