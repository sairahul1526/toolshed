/**
 * Signed values for links and tokens that must not be forgeable: unsubscribe links, confirmation
 * links, embed tokens, download links. Web Crypto only (HMAC-SHA256), so it runs in a Worker and in tests.
 *
 * Every `purpose` string gets its own key derived from `AUTH_SECRET`, so a value signed for one
 * purpose never verifies for another. Pick a short, fixed purpose per feature, for example `unsubscribe`.
 */
import type { Env } from '../env';
import { b64uDecode, b64uEncode } from './keys/encoding';
import { MIN_SECRET_LENGTH, secretStatus } from './secret';

const encoder = new TextEncoder();

interface CachedKey {
  secret: string;
  key: Promise<CryptoKey>;
}

/** Keys are derived once per purpose per isolate. A different secret (tests, rotation) derives a fresh one. */
const keys = new Map<string, CachedKey>();

function keyFor(env: Env, purpose: string): Promise<CryptoKey> {
  const secret = env.AUTH_SECRET;
  const status = secretStatus(secret);
  if (status === 'missing') {
    throw new Error('AUTH_SECRET is not set. Set it in .dev.vars for local work, or with `wrangler secret put AUTH_SECRET` when deploying.');
  }
  if (status === 'short') {
    throw new Error(`AUTH_SECRET is too short. Use a random value of at least ${MIN_SECRET_LENGTH} characters, for example the output of \`openssl rand -base64 32\`.`);
  }
  const cached = keys.get(purpose);
  if (cached && cached.secret === secret) return cached.key;
  const key = (async () => {
    const base = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode('toolshed-signing-v1'), info: encoder.encode(purpose) },
      base,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  })();
  keys.set(purpose, { secret, key });
  key.catch(() => keys.delete(purpose));
  return key;
}

/** HMAC-SHA256 of `data` for `purpose`, as base64url. */
export async function sign(env: Env, purpose: string, data: string): Promise<string> {
  const key = await keyFor(env, purpose);
  return b64uEncode(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}

/** True when `signature` is the signature `sign` gives for this purpose and data. The comparison is constant time. */
export async function verify(env: Env, purpose: string, data: string, signature: string): Promise<boolean> {
  const key = await keyFor(env, purpose);
  const bytes = b64uDecode(signature);
  if (!bytes) return false;
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(data));
}

/**
 * A compact token, `base64url(json).signature`, safe to put in a URL. With `ttlSec` the payload
 * gets `exp` (milliseconds since 1970) and `readSignedToken` refuses it after that time.
 */
export async function signedToken(env: Env, purpose: string, payload: Record<string, unknown>, ttlSec?: number): Promise<string> {
  const body = ttlSec === undefined ? payload : { ...payload, exp: Date.now() + ttlSec * 1000 };
  const encoded = b64uEncode(encoder.encode(JSON.stringify(body)));
  return `${encoded}.${await sign(env, purpose, encoded)}`;
}

/** The payload of a token made by `signedToken`, or null when it is malformed, altered, made for another purpose or expired. */
export async function readSignedToken<T = Record<string, unknown>>(env: Env, purpose: string, token: string, now: number = Date.now()): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!(await verify(env, purpose, parts[0], parts[1]))) return null;
  const bytes = b64uDecode(parts[0]);
  if (!bytes) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (exp !== undefined && (typeof exp !== 'number' || exp <= now)) return null;
  return payload as T;
}
