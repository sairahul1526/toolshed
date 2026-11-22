/**
 * Service accounts: a named identity that is not a person, for keys that should keep working
 * when the member who made them leaves. Only workspace admins see or change them.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { roleAtLeast } from '../../env';
import { newId, orgDb } from '../db';
import { parse } from '../errors';
import { asKeyRole, auditKeys, capRole, isUniqueError, keyErrors, nameSchema, requireAdmin, requireOwnSession, requireSession, roleName, roleSchema } from './shared';
import type { KeyActor, KeyRole } from './shared';

export const MAX_SERVICE_ACCOUNTS = 50;

const ADMIN_ONLY = 'Only workspace admins can manage service accounts. Ask an admin for access.';

export interface ServiceAccount {
  id: string;
  name: string;
  /** Role every key of this account acts with. */
  role: KeyRole;
  createdBy: string;
  createdByLabel: string | null;
  createdAt: number;
  /** Keys that still work (not revoked, not expired). */
  keyCount: number;
}

export interface ServiceAccountRow {
  id: string;
  org_id: string;
  name: string;
  role: string;
  created_by: string;
  created_by_label: string | null;
  created_at: number;
  deleted_at: number | null;
  key_count?: number;
}

function toServiceAccount(row: ServiceAccountRow): ServiceAccount {
  return {
    id: row.id,
    name: row.name,
    role: asKeyRole(row.role) ?? 'viewer',
    createdBy: row.created_by,
    createdByLabel: row.created_by_label,
    createdAt: row.created_at,
    keyCount: row.key_count ?? 0,
  };
}

const WITH_KEY_COUNT = `SELECT s.*, (
    SELECT COUNT(*) FROM api_keys k
    WHERE k.org_id = s.org_id AND k.service_account_id = s.id AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
  ) AS key_count
  FROM service_accounts s WHERE s.org_id = :org AND s.deleted_at IS NULL`;

/** The live row, or `keys.service_account_not_found`. Used when a key is made for the account. */
export async function findServiceAccount(env: Env, orgId: string, id: string, now: number): Promise<ServiceAccountRow> {
  const row = await orgDb(env.DB, orgId).first<ServiceAccountRow>(`${WITH_KEY_COUNT} AND s.id = ?`, now, id);
  if (!row) throw keyErrors.service_account_not_found();
  return row;
}

function checkCeiling(actor: KeyActor, role: KeyRole): void {
  if (!roleAtLeast(capRole(actor.role), role)) throw keyErrors.role_too_high();
}

const createSchema = z.object({ name: nameSchema, role: roleSchema });

export async function createServiceAccount(env: Env, actor: KeyActor, input: { name: string; role: KeyRole }, now = Date.now()): Promise<ServiceAccount> {
  requireOwnSession(actor);
  requireAdmin(actor, ADMIN_ONLY);
  const data = parse(createSchema, input);
  checkCeiling(actor, data.role);
  const db = orgDb(env.DB, actor.orgId);
  const existing = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM service_accounts WHERE org_id = :org AND deleted_at IS NULL');
  if ((existing?.n ?? 0) >= MAX_SERVICE_ACCOUNTS) {
    throw keyErrors.too_many(`A workspace can have ${MAX_SERVICE_ACCOUNTS} service accounts. Delete one you no longer use, then try again.`);
  }
  let row: ServiceAccountRow;
  try {
    row = await db.insert<ServiceAccountRow>('service_accounts', {
      id: newId('svc', now),
      name: data.name,
      role: data.role,
      created_by: actor.userId,
      created_by_label: actor.label ?? null,
      created_at: now,
    });
  } catch (err) {
    if (isUniqueError(err, 'service_accounts_name')) throw keyErrors.name_taken(undefined, { name: 'That name is already used. Pick another.' });
    throw err;
  }
  await auditKeys(env, actor, {
    action: 'service_account.created',
    targetType: 'service_account',
    targetId: row.id,
    summary: `Created the service account ${row.name} as ${roleName(data.role)}`,
    meta: { role: data.role },
  });
  return toServiceAccount(row);
}

export async function listServiceAccounts(env: Env, actor: KeyActor, now = Date.now()): Promise<ServiceAccount[]> {
  requireAdmin(actor, ADMIN_ONLY);
  const rows = await orgDb(env.DB, actor.orgId).all<ServiceAccountRow>(`${WITH_KEY_COUNT} ORDER BY s.created_at, s.id LIMIT ${MAX_SERVICE_ACCOUNTS}`, now);
  return rows.map(toServiceAccount);
}

export async function getServiceAccount(env: Env, actor: KeyActor, id: string, now = Date.now()): Promise<ServiceAccount> {
  requireAdmin(actor, ADMIN_ONLY);
  return toServiceAccount(await findServiceAccount(env, actor.orgId, id, now));
}

const updateSchema = z
  .object({ name: nameSchema.optional(), role: roleSchema.optional() })
  .refine((v) => v.name !== undefined || v.role !== undefined, { message: 'Send a new name or a new role.', path: ['name'] });

/** Rename the account or change its role. A new role applies to its keys on their next request. */
export async function updateServiceAccount(
  env: Env,
  actor: KeyActor,
  id: string,
  patch: { name?: string; role?: KeyRole },
  now = Date.now(),
): Promise<ServiceAccount> {
  requireSession(actor);
  requireAdmin(actor, ADMIN_ONLY);
  const data = parse(updateSchema, patch);
  const before = await findServiceAccount(env, actor.orgId, id, now);
  const name = data.name ?? before.name;
  const role = data.role ?? asKeyRole(before.role) ?? 'viewer';
  if (data.role !== undefined) checkCeiling(actor, data.role);
  try {
    // Keys read their role from the account. The copy on each key is kept in step so an export
    // or a direct query never shows a stale one.
    await env.DB.batch([
      env.DB.prepare('UPDATE service_accounts SET name = ?1, role = ?2 WHERE org_id = ?3 AND id = ?4 AND deleted_at IS NULL').bind(name, role, actor.orgId, id),
      env.DB.prepare('UPDATE api_keys SET role = ?1 WHERE org_id = ?2 AND service_account_id = ?3').bind(role, actor.orgId, id),
    ]);
  } catch (err) {
    if (isUniqueError(err, 'service_accounts_name')) throw keyErrors.name_taken(undefined, { name: 'That name is already used. Pick another.' });
    throw err;
  }
  const changes: string[] = [];
  if (name !== before.name) changes.push(`renamed from ${before.name} to ${name}`);
  if (role !== before.role) changes.push(`role changed from ${roleName(asKeyRole(before.role) ?? 'viewer')} to ${roleName(role)}`);
  if (changes.length > 0) {
    await auditKeys(env, actor, {
      action: 'service_account.updated',
      targetType: 'service_account',
      targetId: id,
      summary: `Service account ${name}: ${changes.join(', ')}`,
      meta: { name: { from: before.name, to: name }, role: { from: before.role, to: role } },
    });
  }
  return toServiceAccount({ ...before, name, role });
}

/** Delete the account and revoke every key it has. Returns how many keys stopped working. */
export async function deleteServiceAccount(env: Env, actor: KeyActor, id: string, now = Date.now()): Promise<{ revokedKeys: number }> {
  requireSession(actor);
  requireAdmin(actor, ADMIN_ONLY);
  const before = await findServiceAccount(env, actor.orgId, id, now);
  const [, keys] = await env.DB.batch([
    env.DB.prepare('UPDATE service_accounts SET deleted_at = ?1 WHERE org_id = ?2 AND id = ?3 AND deleted_at IS NULL').bind(now, actor.orgId, id),
    env.DB.prepare(
      `UPDATE api_keys SET revoked_at = ?1, revoked_reason = 'service_account_deleted'
       WHERE org_id = ?2 AND service_account_id = ?3 AND revoked_at IS NULL`,
    ).bind(now, actor.orgId, id),
  ]);
  const revokedKeys = keys?.meta.changes ?? 0;
  await auditKeys(env, actor, {
    action: 'service_account.deleted',
    targetType: 'service_account',
    targetId: id,
    summary: `Deleted the service account ${before.name} and revoked ${revokedKeys} ${revokedKeys === 1 ? 'key' : 'keys'}`,
    meta: { revokedKeys },
  });
  return { revokedKeys };
}
