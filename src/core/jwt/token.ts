/**
 * Writing and checking the token itself: three base64url parts, `header.payload.signature`.
 * No library: the format is small, and owning every check is the point.
 */
import type { Env } from '../../env';
import { b64uDecode, b64uEncode, fromUtf8, randomBytes, utf8 } from '../keys/encoding';
import { findVerifier, getSigner, JWT_ALG, MAX_TOKEN_TTL_SECONDS } from './keystore';

/** Every token from this install is for this audience. */
export const JWT_AUDIENCE = 'toolshed';
/** Allowed difference between our clock and the clock that made or checks a token. */
export const CLOCK_SKEW_SECONDS = 30;
/** Longer input is refused before any parsing. Real tokens are well under 1,000 characters. */
const MAX_TOKEN_LENGTH = 8192;
const ECDSA = { name: 'ECDSA', hash: 'SHA-256' } as const;
const KID = /^[A-Za-z0-9_-]{1,64}$/;
/** An ES256 signature is two 32 byte numbers. */
const SIGNATURE_BYTES = 64;

export interface TokenOptions {
  /**
   * This install's address, used when APP_URL is not set. Pass the request's origin
   * (`new URL(c.req.url).origin`). APP_URL wins when both are there.
   */
  issuer?: string;
  /** The current time in ms, for tests. */
  now?: number;
}

/** The claims every token has. `exp`, `iat` and `nbf` are seconds since 1970, as JWT wants. */
export interface StandardClaims {
  iss: string;
  aud: string;
  sub: string;
  iat: number;
  exp: number;
  nbf?: number;
  jti: string;
}

/** The `iss` of this install's tokens: the origin of APP_URL, or of the fallback. Null when neither is a URL. */
export function issuerFor(env: Env, fallback?: string): string | null {
  for (const candidate of [env.APP_URL, fallback]) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.origin;
    } catch {
      // Not a URL. Try the next one.
    }
  }
  return null;
}

function encodeJson(value: unknown): string {
  return b64uEncode(utf8(JSON.stringify(value)));
}

function decodeJson(part: string): Record<string, unknown> | null {
  const bytes = b64uDecode(part);
  const text = bytes && fromUtf8(bytes);
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface SignOptions extends TokenOptions {
  ttlSeconds: number;
  /** The token is refused before this time (ms). */
  notBefore?: number;
}

/**
 * Sign `claims` plus the standard ones. Throws on a bad life span or a missing issuer: both are
 * mistakes in the calling code or the install's settings, not something a caller can fix.
 */
export async function signToken(env: Env, claims: Record<string, unknown> & { sub: string }, opts: SignOptions): Promise<{ token: string; expiresAt: number }> {
  const now = opts.now ?? Date.now();
  if (!Number.isInteger(opts.ttlSeconds) || opts.ttlSeconds < 1 || opts.ttlSeconds > MAX_TOKEN_TTL_SECONDS) {
    throw new Error(`A token must live between 1 and ${MAX_TOKEN_TTL_SECONDS} seconds`);
  }
  const iss = issuerFor(env, opts.issuer);
  if (!iss) throw new Error('Cannot sign a token without an issuer. Set APP_URL or pass the request origin.');
  const iat = Math.floor(now / 1000);
  const payload: Record<string, unknown> & StandardClaims = {
    ...claims,
    iss,
    aud: JWT_AUDIENCE,
    iat,
    exp: iat + opts.ttlSeconds,
    ...(opts.notBefore === undefined ? {} : { nbf: Math.floor(opts.notBefore / 1000) }),
    jti: b64uEncode(randomBytes(16)),
  };
  const signer = await getSigner(env, now);
  const signingInput = `${encodeJson({ alg: JWT_ALG, typ: 'JWT', kid: signer.kid })}.${encodeJson(payload)}`;
  const signature = await crypto.subtle.sign(ECDSA, signer.key, utf8(signingInput));
  const token = `${signingInput}.${b64uEncode(new Uint8Array(signature))}`;
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('That token would be too long. Give it fewer scopes.');
  return { token, expiresAt: payload.exp * 1000 };
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Check a token and return its payload, or null. Every check, in order:
 * 1. Size and shape: three base64url parts.
 * 2. Header: `alg` is exactly ES256. `none`, HS256 and every other value are refused, so a token
 *    cannot pick a weaker check. No `crit` extensions. `typ`, when present, is JWT.
 * 3. Key: looked up by `kid` among this install's own keys. A key sent inside the token
 *    (`jwk`, `jku`, `x5u`) is never read.
 * 4. Signature over the exact bytes received.
 * 5. Claims: `iss` is this install, `aud` is toolshed, `exp` is ahead, `nbf` and `iat` are not,
 *    and the life span is no longer than the longest we ever sign.
 */
export async function readToken(env: Env, token: string, opts: TokenOptions = {}): Promise<(Record<string, unknown> & StandardClaims) | null> {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  if (!headerPart || !payloadPart || !signaturePart) return null;

  const header = decodeJson(headerPart);
  if (!header || header.alg !== JWT_ALG || 'crit' in header) return null;
  if (header.typ !== undefined && header.typ !== 'JWT') return null;
  if (typeof header.kid !== 'string' || !KID.test(header.kid)) return null;

  const signature = b64uDecode(signaturePart);
  if (!signature || signature.length !== SIGNATURE_BYTES) return null;

  const now = opts.now ?? Date.now();
  const key = await findVerifier(env, header.kid, now);
  if (!key) return null;
  const valid = await crypto.subtle.verify(ECDSA, key, signature, utf8(`${headerPart}.${payloadPart}`));
  if (!valid) return null;

  const payload = decodeJson(payloadPart);
  if (!payload) return null;
  const { iss, aud, sub, iat, exp, nbf, jti } = payload;
  const expected = issuerFor(env, opts.issuer);
  if (!expected || iss !== expected || aud !== JWT_AUDIENCE) return null;
  if (typeof sub !== 'string' || sub === '' || typeof jti !== 'string') return null;
  if (!isWholeNumber(iat) || !isWholeNumber(exp)) return null;
  if (nbf !== undefined && !isWholeNumber(nbf)) return null;
  const seconds = Math.floor(now / 1000);
  if (exp <= iat || exp - iat > MAX_TOKEN_TTL_SECONDS) return null;
  if (exp + CLOCK_SKEW_SECONDS <= seconds) return null;
  if (iat > seconds + CLOCK_SKEW_SECONDS) return null;
  if (nbf !== undefined && nbf > seconds + CLOCK_SKEW_SECONDS) return null;
  return { ...payload, iss, aud, sub, iat, exp, jti, ...(nbf === undefined ? {} : { nbf }) };
}
