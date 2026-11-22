/**
 * Checking a key on a request. This is the hot path: every API call made with a key runs it,
 * so it does one database read and nothing else.
 */
import type { Env } from '../../env';
import { enforceRateLimit } from '../ratelimit';
import type { RateLimitRule } from '../ratelimit';
import { constantTimeEqual, fromHex } from './encoding';
import { hashKeyBytes, parseKey } from './format';
import { KEY_SELECT, keyStatus, rowRole, rowScopes } from './rows';
import type { KeyKind, KeyRow } from './rows';
import type { KeyRole } from './shared';

export interface VerifiedKey {
  orgId: string;
  /** Stable id of the key. Use it for rate limits and the audit log. */
  keyId: string;
  name: string;
  scopes: string[];
  /** Role the key acts with inside the workspace. Never `owner`. */
  role: KeyRole;
  kind: KeyKind;
  /** The member a personal key belongs to. Null for service keys. */
  userId: string | null;
  serviceAccountId: string | null;
  serviceAccountName: string | null;
  /** `ts_live_` plus the key id. Safe to log. */
  prefix: string;
  lastUsedAt: number | null;
}

/**
 * The role a stored key acts with right now, or null when it no longer works: revoked, expired,
 * or a service key whose account is gone. A token made from a key is checked with this on every
 * request, so it stops with its key and not 15 minutes later.
 */
export function liveKeyRole(row: Pick<KeyRow, 'kind' | 'role' | 'revoked_at' | 'expires_at' | 'sa_role' | 'sa_deleted_at'>, now: number): KeyRole | null {
  if (keyStatus(row, now) !== 'active') return null;
  // A service key is only as alive as its account.
  if (row.kind === 'service' && (row.sa_role === null || row.sa_deleted_at !== null)) return null;
  return rowRole(row);
}

/**
 * Check a bearer token. Returns null when it is not a live key.
 *
 * - A key with a bad shape or checksum is refused before the database is asked.
 * - Otherwise there is exactly one read, by the key's public prefix, and nothing is cached,
 *   so a revoked key stops on the very next request.
 * - The stored hash is compared in constant time.
 */
export async function verifyApiKey(env: Env, token: string, now = Date.now()): Promise<VerifiedKey | null> {
  const parsed = parseKey(token);
  if (!parsed) return null;
  const row = await env.DB.prepare(`${KEY_SELECT} WHERE k.prefix = ?1`).bind(parsed.prefix).first<KeyRow>();
  // Hash even when no row was found, so a miss takes as long as a wrong secret.
  const sent = await hashKeyBytes(token);
  const stored = row ? fromHex(row.key_hash) : null;
  if (!row || !stored || !constantTimeEqual(sent, stored)) return null;
  const role = liveKeyRole(row, now);
  if (!role) return null;
  const kind: KeyKind = row.kind === 'service' ? 'service' : 'personal';
  return {
    orgId: row.org_id,
    keyId: row.id,
    name: row.name,
    scopes: rowScopes(row),
    role,
    kind,
    userId: row.user_id,
    serviceAccountId: row.service_account_id,
    serviceAccountName: row.sa_name,
    prefix: row.prefix,
    lastUsedAt: row.last_used_at,
  };
}

/** "Last used" is written at most this often per key, so a busy key costs one write a minute. */
export const LAST_USED_INTERVAL_MS = 60_000;

/**
 * Record that a key was just used. Does nothing, and touches no database, when the key was
 * already marked within the last minute. Returns whether a write happened.
 *
 * Call it after the response is on its way so the request does not wait for it:
 * `c.executionCtx.waitUntil(touchApiKey(c.env, key, { ip }))`.
 */
export async function touchApiKey(
  env: Env,
  key: Pick<VerifiedKey, 'keyId' | 'orgId' | 'lastUsedAt'>,
  opts: { ip?: string | null; now?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (key.lastUsedAt !== null && now - key.lastUsedAt < LAST_USED_INTERVAL_MS) return false;
  // The WHERE repeats the check, so of several requests racing on a stale read only one writes.
  const res = await env.DB.prepare(
    `UPDATE api_keys SET last_used_at = ?1, last_used_ip = ?2
     WHERE org_id = ?3 AND id = ?4 AND (last_used_at IS NULL OR last_used_at <= ?5)`,
  )
    .bind(now, opts.ip ?? null, key.orgId, key.keyId, now - LAST_USED_INTERVAL_MS)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

/** Calls one key may make. Past it the caller gets `rate_limited` with a Retry-After header. */
export const API_KEY_RATE_LIMIT: RateLimitRule = { limit: 300, windowSec: 60 };

/** Count one call against a key and throw `rate_limited` when it is over its limit. */
export function enforceApiKeyRateLimit(env: Env, keyId: string): Promise<void> {
  return enforceRateLimit(env, `apikey:${keyId}`, API_KEY_RATE_LIMIT, 'This key is making too many calls. Slow down, then try again.');
}
