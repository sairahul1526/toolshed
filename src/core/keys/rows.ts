/**
 * How an API key is stored and how it is shown. The stored hash never leaves this folder:
 * `toApiKey` is the only way a row becomes something a screen or the API can return.
 */
import type { Env } from '../../env';
import { parseJson } from '../db';
import type { Scalar } from '../db';
import { asKeyRole } from './shared';
import type { KeyRole } from './shared';

export type KeyKind = 'personal' | 'service';
export type KeyStatus = 'active' | 'expired' | 'revoked';

/** A key as lists, screens and the API see it. There is no secret and no hash in here. */
export interface ApiKey {
  id: string;
  name: string;
  /** `personal` keys stop working when their member leaves. `service` keys belong to a service account. */
  kind: KeyKind;
  /** `ts_live_` plus the key id. Enough to tell keys apart, useless for signing in. */
  prefix: string;
  scopes: string[];
  role: KeyRole;
  userId: string | null;
  serviceAccountId: string | null;
  serviceAccountName: string | null;
  createdBy: string;
  createdByLabel: string | null;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  lastUsedIp: string | null;
  revokedAt: number | null;
  status: KeyStatus;
  /** Id of the key this one replaced, when it came from a rotation. */
  rotatedFrom: string | null;
  /** Id of the key that replaced this one. */
  replacedBy: string | null;
}

export interface KeyRow {
  id: string;
  org_id: string;
  name: string;
  kind: string;
  user_id: string | null;
  service_account_id: string | null;
  prefix: string;
  key_hash: string;
  scopes: string;
  role: string;
  expires_at: number | null;
  created_by: string;
  created_by_label: string | null;
  created_at: number;
  last_used_at: number | null;
  last_used_ip: string | null;
  revoked_at: number | null;
  revoked_reason: string | null;
  rotated_from: string | null;
  replaced_by: string | null;
  /** From the joined service account. Null for personal keys. */
  sa_name: string | null;
  sa_role: string | null;
  sa_deleted_at: number | null;
}

/** A key with its service account, when it has one. Add a WHERE on `k.`. */
export const KEY_SELECT = `SELECT k.*, s.name AS sa_name, s.role AS sa_role, s.deleted_at AS sa_deleted_at
  FROM api_keys k LEFT JOIN service_accounts s ON s.id = k.service_account_id AND s.org_id = k.org_id`;

export function rowScopes(row: Pick<KeyRow, 'scopes'>): string[] {
  const parsed = parseJson<unknown>(row.scopes, []);
  return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
}

/**
 * The role a key acts with. A service key follows its account, so changing the account's role
 * changes every key it has. Anything unreadable falls back to the weakest role.
 */
export function rowRole(row: Pick<KeyRow, 'kind' | 'role' | 'sa_role'>): KeyRole {
  return (row.kind === 'service' ? asKeyRole(row.sa_role) : asKeyRole(row.role)) ?? 'viewer';
}

export function keyStatus(row: Pick<KeyRow, 'revoked_at' | 'expires_at'>, now: number): KeyStatus {
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at !== null && row.expires_at <= now) return 'expired';
  return 'active';
}

export function toApiKey(row: KeyRow, now: number): ApiKey {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind === 'service' ? 'service' : 'personal',
    prefix: row.prefix,
    scopes: rowScopes(row),
    role: rowRole(row),
    userId: row.user_id,
    serviceAccountId: row.service_account_id,
    serviceAccountName: row.sa_name,
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
    revokedAt: row.revoked_at,
    status: keyStatus(row, now),
    rotatedFrom: row.rotated_from,
    replacedBy: row.replaced_by,
  };
}

const INSERT_COLUMNS = [
  'id',
  'org_id',
  'name',
  'kind',
  'user_id',
  'service_account_id',
  'prefix',
  'key_hash',
  'scopes',
  'role',
  'expires_at',
  'created_by',
  'created_by_label',
  'created_at',
  'rotated_from',
] as const satisfies readonly (keyof KeyRow)[];

/**
 * The statement that stores a new key. With `replacing`, the row is only written while the key
 * it replaces is still live and not yet replaced, so two rotations at once cannot both win.
 */
export function insertKeyStatement(env: Env, row: KeyRow, replacing?: string): D1PreparedStatement {
  const values: Scalar[] = INSERT_COLUMNS.map((column) => row[column]);
  const marks = INSERT_COLUMNS.map((_, i) => `?${i + 1}`).join(', ');
  const guard = replacing
    ? ` WHERE EXISTS (SELECT 1 FROM api_keys WHERE id = ?${values.length + 1} AND org_id = ?2 AND revoked_at IS NULL AND replaced_by IS NULL)`
    : '';
  return env.DB.prepare(`INSERT INTO api_keys (${INSERT_COLUMNS.join(', ')}) SELECT ${marks}${guard}`).bind(...values, ...(replacing ? [replacing] : []));
}
