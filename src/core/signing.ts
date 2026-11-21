/**
 * Signed values for links and tokens that must not be forgeable: unsubscribe links, confirmation
 * links, embed tokens, download links. Web Crypto only (HMAC-SHA256), so it runs in a Worker and in tests.
 *
 * Every `purpose` string gets its own key derived from `AUTH_SECRET`, so a value signed for one
 * purpose never verifies for another. Pick a short, fixed purpose per feature, for example `unsubscribe`.
 */
import type { Env } from '../env';

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Returns null for anything that is not canonical base64url, so a signature has one spelling only. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    return null;
  }
}

interface CachedKey {
  secret: string;
  key: Promise<CryptoKey>;
}

/** Keys are derived once per purpose per isolate. A different secret (tests, rotation) derives a fresh one. */
const keys = new Map<string, CachedKey>();

function keyFor(env: Env, purpose: string): Promise<CryptoKey> {
  const secret = env.AUTH_SECRET;
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new Error('AUTH_SECRET is not set. Set it in .dev.vars for local work, or with `wrangler secret put AUTH_SECRET` when deploying.');
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
  return toBase64Url(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data))));
}

/** True when `signature` is the signature `sign` gives for this purpose and data. The comparison is constant time. */
export async function verify(env: Env, purpose: string, data: string, signature: string): Promise<boolean> {
  const key = await keyFor(env, purpose);
  const bytes = fromBase64Url(signature);
  if (!bytes) return false;
  return crypto.subtle.verify('HMAC', key, bytes, encoder.encode(data));
}

/**
 * A compact token, `base64url(json).signature`, safe to put in a URL. With `ttlSec` the payload
 * gets `exp` (milliseconds since 1970) and `readSignedToken` refuses it after that time.
 */
export async function signedToken(env: Env, purpose: string, payload: Record<string, unknown>, ttlSec?: number): Promise<string> {
  const body = ttlSec === undefined ? payload : { ...payload, exp: Date.now() + ttlSec * 1000 };
  const encoded = toBase64Url(encoder.encode(JSON.stringify(body)));
  return `${encoded}.${await sign(env, purpose, encoded)}`;
}

/** The payload of a token made by `signedToken`, or null when it is malformed, altered, made for another purpose or expired. */
export async function readSignedToken<T = Record<string, unknown>>(env: Env, purpose: string, token: string, now: number = Date.now()): Promise<T | null> {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  if (!(await verify(env, purpose, parts[0], parts[1]))) return null;
  const bytes = fromBase64Url(parts[0]);
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
