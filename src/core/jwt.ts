/**
 * Short-lived JSON Web Tokens, so other services can call the API, and check a caller, without
 * a database lookup. Access tokens live 15 minutes. Public keys are at /.well-known/jwks.json.
 *
 * Two kinds of token, told apart by the `kind` claim so one can never stand in for the other:
 * - Access tokens (`user`, `key`): a bearer token for the API. Made by POST /api/v1/token.
 * - Embed tokens (`embed`): made by a module for one of its own widgets. See `signEmbedToken`.
 *
 * The parts live in `./jwt/`: keystore (signing keys, rotation, caches) and token (the format).
 */
import type { Env } from '../env';
import { readToken, signToken } from './jwt/token';
import type { TokenOptions } from './jwt/token';
import { MAX_SCOPES } from './keys/scopes';
import { asKeyRole } from './keys/shared';
import type { KeyRole } from './keys/shared';

export { getJwks, getSigningKeyStatus, JWT_ALG, KEY_ROTATE_AFTER_MS, MAX_TOKEN_TTL_SECONDS, rotateSigningKey } from './jwt/keystore';
export type { Jwks, PublicJwk, RotateOptions } from './jwt/keystore';
export { CLOCK_SKEW_SECONDS, issuerFor, JWT_AUDIENCE } from './jwt/token';
export type { TokenOptions } from './jwt/token';

/** How long an access token lives. */
export const TOKEN_TTL_SECONDS = 15 * 60;

const MODULE_ID = /^[a-z][a-z0-9-]{1,30}$/;
/** Printable, no spaces, short. Which scopes exist is checked where a token is asked for. */
const SCOPE = /^[\x21-\x7e]{1,100}$/;
const MAX_SUBJECT_LENGTH = 200;

export interface JwtClaims {
  /** User id, or API key id for tokens made from a key. */
  sub: string;
  orgId: string;
  /** Role the token acts with. Never `owner`. */
  role: KeyRole;
  scopes: string[];
  /** `user` when a signed-in person asked for it, `key` when an API key did. */
  kind: 'user' | 'key';
  /** Seconds since 1970, as in the token. */
  exp: number;
  iat: number;
  nbf?: number;
  iss: string;
  aud: string;
  /** Unique id of this token, for logs. */
  jti: string;
}

function readScopes(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MAX_SCOPES) return null;
  return value.every((s): s is string => typeof s === 'string' && SCOPE.test(s)) ? value : null;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SUBJECT_LENGTH;
}

export interface SignJwtOptions extends TokenOptions {
  /** Defaults to 15 minutes, which is also the longest an access token may live. */
  ttlSeconds?: number;
  /** The token is refused before this time (ms). */
  notBefore?: number;
}

/**
 * Sign an access token. This does not decide what the caller is allowed: check the role and
 * scopes against the caller's own before calling (POST /api/v1/token does).
 */
export async function signJwt(
  env: Env,
  claims: { sub: string; orgId: string; role: KeyRole; scopes: string[]; kind?: 'user' | 'key' },
  opts: SignJwtOptions = {},
): Promise<{ token: string; expiresAt: number }> {
  if (!isId(claims.sub) || !isId(claims.orgId)) throw new Error('A token needs a subject and a workspace');
  if (!asKeyRole(claims.role)) throw new Error('A token can act as Admin, Member or Viewer, never as the owner');
  if (!readScopes(claims.scopes)) throw new Error('A token’s scopes must be a short list of scope names');
  // verifyJwt refuses a longer life, so signing one would only hand out a token that never works.
  if (opts.ttlSeconds !== undefined && opts.ttlSeconds > TOKEN_TTL_SECONDS) throw new Error(`An access token can live at most ${TOKEN_TTL_SECONDS} seconds`);
  return signToken(
    env,
    { sub: claims.sub, org: claims.orgId, role: claims.role, scopes: claims.scopes, kind: claims.kind ?? 'user' },
    { ...opts, ttlSeconds: opts.ttlSeconds ?? TOKEN_TTL_SECONDS },
  );
}

/**
 * Check a bearer token. Returns null when it is not a valid, unexpired access token from this
 * install. With the public key cached (in this Worker instance or in KV) it reads no database.
 */
export async function verifyJwt(env: Env, token: string, opts: TokenOptions = {}): Promise<JwtClaims | null> {
  const payload = await readToken(env, token, opts);
  if (!payload) return null;
  // readToken allows a day, for embed tokens. Access tokens are the 15 minute kind only.
  if (payload.exp - payload.iat > TOKEN_TTL_SECONDS) return null;
  const role = asKeyRole(payload.role);
  const scopes = readScopes(payload.scopes);
  if ((payload.kind !== 'user' && payload.kind !== 'key') || !isId(payload.sub) || !isId(payload.org) || !role || !scopes) return null;
  return {
    sub: payload.sub,
    orgId: payload.org,
    role,
    scopes,
    kind: payload.kind,
    exp: payload.exp,
    iat: payload.iat,
    ...(payload.nbf === undefined ? {} : { nbf: payload.nbf }),
    iss: payload.iss,
    aud: payload.aud,
    jti: payload.jti,
  };
}

export interface EmbedTokenInput {
  orgId: string;
  /** The module the token is for. Its scopes must start with `<module>:`. */
  module: string;
  /** Who or what the token speaks for, for example a visitor id or `board:brd_123`. The module decides. */
  subject: string;
  scopes: string[];
  /** Defaults to 15 minutes. At most a day. */
  ttlSeconds?: number;
}

export interface EmbedClaims {
  sub: string;
  orgId: string;
  module: string;
  scopes: string[];
  exp: number;
  iat: number;
  jti: string;
}

/**
 * Sign a token for one of a module's own widgets or embeds. For module authors.
 *
 *   const { token } = await signEmbedToken(env, {
 *     orgId: org.id, module: 'feedback', subject: `board:${board.id}`, scopes: ['feedback:vote'], ttlSeconds: 3600,
 *   });
 *
 * Hand the token to the widget, then check it in the module's public route with
 * `verifyEmbedToken(env, token, { module: 'feedback' })` and use the returned `orgId`.
 *
 * An embed token is not an API token: the API refuses it, it has no role, and its scopes can
 * only belong to its own module. Treat it as public once it reaches a browser, so give it the
 * narrowest scope and the shortest life that works.
 */
export async function signEmbedToken(env: Env, input: EmbedTokenInput, opts: TokenOptions = {}): Promise<{ token: string; expiresAt: number }> {
  if (!MODULE_ID.test(input.module)) throw new Error('An embed token needs a module id');
  if (!isId(input.orgId) || !isId(input.subject)) throw new Error('An embed token needs a workspace and a subject');
  const scopes = readScopes(input.scopes);
  if (!scopes || scopes.length === 0 || !scopes.every((s) => s.startsWith(`${input.module}:`) && !s.includes('*'))) {
    throw new Error(`An embed token’s scopes must be named scopes of its own module, such as ${input.module}:read`);
  }
  return signToken(
    env,
    { sub: input.subject, org: input.orgId, kind: 'embed', module: input.module, scopes },
    { ...opts, ttlSeconds: input.ttlSeconds ?? TOKEN_TTL_SECONDS },
  );
}

/**
 * Check an embed token. Returns null unless it is valid, unexpired and made for `expect.module`
 * (and for `expect.orgId`, when given).
 */
export async function verifyEmbedToken(env: Env, token: string, expect: { module: string; orgId?: string }, opts: TokenOptions = {}): Promise<EmbedClaims | null> {
  const payload = await readToken(env, token, opts);
  if (!payload || payload.kind !== 'embed' || payload.module !== expect.module) return null;
  const scopes = readScopes(payload.scopes);
  if (!isId(payload.sub) || !isId(payload.org) || !scopes || !scopes.every((s) => s.startsWith(`${expect.module}:`))) return null;
  if (expect.orgId !== undefined && payload.org !== expect.orgId) return null;
  return { sub: payload.sub, orgId: payload.org, module: expect.module, scopes, exp: payload.exp, iat: payload.iat, jti: payload.jti };
}
