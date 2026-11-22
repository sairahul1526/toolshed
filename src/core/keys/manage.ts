/**
 * Making, listing, renaming, revoking and rotating API keys.
 *
 * Every function takes the actor and checks its own permission, so a screen or route cannot
 * forget to. The rules:
 * - Only a signed-in person changes keys. A key or token never can.
 * - Anyone may make a personal key, never stronger than their own role.
 * - Service accounts and their keys are for workspace admins.
 * - Admins see and revoke every key. Everyone else sees and revokes only their own.
 * - Only the member a personal key belongs to may rotate it, because the new secret acts as them.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { isDev, roleAtLeast } from '../../env';
import { newId, orgDb } from '../db';
import { errors, parse } from '../errors';
import { generateKey, hashKey } from './format';
import type { NewKey } from './format';
import { insertKeyStatement, KEY_SELECT, keyStatus, rowRole, toApiKey } from './rows';
import type { ApiKey, KeyRow } from './rows';
import { checkScopes, MAX_SCOPES } from './scopes';
import { findServiceAccount } from './service-accounts';
import { asKeyRole, auditKeys, capRole, isAdmin, isUniqueError, keyErrors, nameSchema, requireAdmin, requireOwnSession, requireSession, roleName, roleSchema, weakerRole } from './shared';
import type { KeyActor, KeyRole } from './shared';

/** Keys that still work, per workspace. Keeps lists one page and one query. */
export const MAX_ACTIVE_KEYS = 250;
/** How long an old key may keep working after a rotation, at most. */
export const MAX_ROTATE_GRACE_SECONDS = 7 * 24 * 60 * 60;

const DAY_MS = 24 * 60 * 60 * 1000;
const LIST_LIMIT = 500;
const NO_KEY = 'There is no key with that id. It may have been deleted.';

const createSchema = z.strictObject({
  name: nameSchema,
  scopes: z
    .array(z.string('Each permission is a name such as links:read.').max(100, 'That permission name is too long.'), 'Pick at least one permission.')
    .min(1, 'Pick at least one permission.')
    .max(MAX_SCOPES, `Pick at most ${MAX_SCOPES} permissions, or use * for everything.`),
  role: roleSchema.optional(),
  expiresInDays: z
    .number('Send the number of days as a whole number, or leave it out for a key that never expires.')
    .int('Send the number of days as a whole number.')
    .min(1, 'A key must last at least 1 day.')
    .max(3650, 'A key can last at most 10 years. Leave this out for a key that never expires.')
    .nullable()
    .optional(),
  serviceAccountId: z.string('Send the id of a service account.').min(1, 'Send the id of a service account.').max(64, 'That id is too long.').nullable().optional(),
});

export interface CreateKeyInput {
  name: string;
  /** Module scopes such as `links:read`, `<module>:*`, or `*` for everything. */
  scopes: string[];
  /** Defaults to the creator's role (Admin for the owner). Not allowed with `serviceAccountId`. */
  role?: KeyRole;
  /** Leave out or send null for a key that never expires. */
  expiresInDays?: number | null;
  /** Make the key act as this service account instead of the creator. Admins only. */
  serviceAccountId?: string | null;
}

export interface CreatedKey {
  key: ApiKey;
  /** The full key. This is the only time it exists outside the caller's hands. */
  secret: string;
}

/** Store a row built from a fresh key. A clash on the 8 character key id is retried with a new one. */
async function withNewKey<T>(env: Env, store: (key: NewKey, hash: string) => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const key = generateKey(isDev(env) ? 'test' : 'live');
    try {
      return await store(key, await hashKey(key.secret));
    } catch (err) {
      if (attempt >= 3 || !isUniqueError(err, 'api_keys.prefix')) throw err;
    }
  }
}

async function findKey(env: Env, orgId: string, id: string): Promise<KeyRow | null> {
  return orgDb(env.DB, orgId).first<KeyRow>(`${KEY_SELECT} WHERE k.org_id = :org AND k.id = ?`, id);
}

function ownsKey(actor: KeyActor, row: KeyRow): boolean {
  return row.kind === 'personal' && row.user_id === actor.userId;
}

/** The key, when the actor may see it. Someone else's key looks the same as a missing one. */
async function visibleKey(env: Env, actor: KeyActor, id: string): Promise<KeyRow> {
  const row = await findKey(env, actor.orgId, id);
  if (!row || (!isAdmin(actor) && !ownsKey(actor, row))) throw errors.not_found(NO_KEY);
  return row;
}

export async function createApiKey(env: Env, actor: KeyActor, input: CreateKeyInput, now = Date.now()): Promise<CreatedKey> {
  requireOwnSession(actor);
  const data = parse(createSchema, input);
  const scopes = checkScopes(data.scopes);

  let role: KeyRole;
  let serviceAccount: { id: string; name: string } | null = null;
  if (data.serviceAccountId) {
    requireAdmin(actor, 'Only workspace admins can make keys for a service account. Ask an admin for access.');
    const account = await findServiceAccount(env, actor.orgId, data.serviceAccountId, now);
    role = asKeyRole(account.role) ?? 'viewer';
    if (data.role !== undefined && data.role !== role) {
      throw errors.validation_failed(undefined, {
        role: `A service account’s keys use its role (${roleName(role)}). Leave the role out, or change the account’s role.`,
      });
    }
    serviceAccount = { id: account.id, name: account.name };
  } else {
    const ceiling = capRole(actor.role);
    role = data.role ?? ceiling;
    if (!roleAtLeast(ceiling, role)) throw keyErrors.role_too_high();
  }

  const active = await orgDb(env.DB, actor.orgId).first<{ n: number }>(
    'SELECT COUNT(*) AS n FROM api_keys WHERE org_id = :org AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)',
    now,
  );
  if ((active?.n ?? 0) >= MAX_ACTIVE_KEYS) throw keyErrors.too_many();

  const { row, secret } = await withNewKey(env, async (key, hash) => {
    const fresh: KeyRow = {
      id: newId('key', now),
      org_id: actor.orgId,
      name: data.name,
      kind: serviceAccount ? 'service' : 'personal',
      user_id: serviceAccount ? null : actor.userId,
      service_account_id: serviceAccount?.id ?? null,
      prefix: key.prefix,
      key_hash: hash,
      scopes: JSON.stringify(scopes),
      role,
      expires_at: data.expiresInDays ? now + data.expiresInDays * DAY_MS : null,
      created_by: actor.userId,
      created_by_label: actor.label ?? null,
      created_at: now,
      last_used_at: null,
      last_used_ip: null,
      revoked_at: null,
      revoked_reason: null,
      rotated_from: null,
      replaced_by: null,
      sa_name: serviceAccount?.name ?? null,
      sa_role: serviceAccount ? role : null,
      sa_deleted_at: null,
    };
    await insertKeyStatement(env, fresh).run();
    return { row: fresh, secret: key.secret };
  });

  await auditKeys(env, actor, {
    action: 'api_key.created',
    targetType: 'api_key',
    targetId: row.id,
    summary: serviceAccount
      ? `Created the key ${row.name} for the service account ${serviceAccount.name}`
      : `Created the key ${row.name} as ${roleName(role)}`,
    meta: { prefix: row.prefix, kind: row.kind, role, scopes, expiresAt: row.expires_at, serviceAccountId: row.service_account_id },
  });
  return { key: toApiKey(row, now), secret };
}

/** Newest first. Revoked keys are left out unless asked for. Never returns a secret or a hash. */
export async function listApiKeys(env: Env, actor: KeyActor, opts: { includeRevoked?: boolean } = {}, now = Date.now()): Promise<ApiKey[]> {
  const db = orgDb(env.DB, actor.orgId);
  const live = opts.includeRevoked ? '' : ' AND k.revoked_at IS NULL';
  const order = ` ORDER BY k.created_at DESC, k.id DESC LIMIT ${LIST_LIMIT}`;
  const rows = isAdmin(actor)
    ? await db.all<KeyRow>(`${KEY_SELECT} WHERE k.org_id = :org${live}${order}`)
    : await db.all<KeyRow>(`${KEY_SELECT} WHERE k.org_id = :org AND k.kind = 'personal' AND k.user_id = ?${live}${order}`, actor.userId);
  return rows.map((row) => toApiKey(row, now));
}

export async function getApiKey(env: Env, actor: KeyActor, id: string, now = Date.now()): Promise<ApiKey> {
  return toApiKey(await visibleKey(env, actor, id), now);
}

export async function renameApiKey(env: Env, actor: KeyActor, id: string, name: string, now = Date.now()): Promise<ApiKey> {
  requireSession(actor);
  const data = parse(z.strictObject({ name: nameSchema }), { name });
  const row = await visibleKey(env, actor, id);
  if (row.revoked_at !== null) throw keyErrors.revoked();
  if (data.name === row.name) return toApiKey(row, now);
  await orgDb(env.DB, actor.orgId).run('UPDATE api_keys SET name = ? WHERE org_id = :org AND id = ?', data.name, id);
  await auditKeys(env, actor, {
    action: 'api_key.renamed',
    targetType: 'api_key',
    targetId: id,
    summary: `Renamed the key ${row.name} to ${data.name}`,
    meta: { prefix: row.prefix, from: row.name, to: data.name },
  });
  return toApiKey({ ...row, name: data.name }, now);
}

/** Stop a key working, right away. Revoking a key that is already revoked changes nothing. */
export async function revokeApiKey(env: Env, actor: KeyActor, id: string, now = Date.now()): Promise<ApiKey> {
  requireSession(actor);
  const row = await visibleKey(env, actor, id);
  if (row.revoked_at !== null) return toApiKey(row, now);
  const { changes } = await orgDb(env.DB, actor.orgId).run(
    "UPDATE api_keys SET revoked_at = ?, revoked_reason = 'manual' WHERE org_id = :org AND id = ? AND revoked_at IS NULL",
    now,
    id,
  );
  if (changes > 0) {
    await auditKeys(env, actor, {
      action: 'api_key.revoked',
      targetType: 'api_key',
      targetId: id,
      summary: `Revoked the key ${row.name}`,
      meta: { prefix: row.prefix, kind: row.kind },
    });
  }
  return toApiKey({ ...row, revoked_at: now, revoked_reason: 'manual' }, now);
}

const rotateSchema = z.strictObject({
  graceSeconds: z
    .number('Send the grace time in seconds, as a whole number.')
    .int('Send the grace time in seconds, as a whole number.')
    .min(0, 'The grace time can’t be negative.')
    .max(MAX_ROTATE_GRACE_SECONDS, 'The old key can keep working for 7 days at most.')
    .optional(),
});

export interface RotatedKey extends CreatedKey {
  /** The key that was replaced, as it is now. */
  previous: ApiKey;
}

/**
 * Replace a key with a new one that has the same name, scopes and owner, and a fresh secret.
 *
 * The old key stops at once unless `graceSeconds` is given. A grace time (7 days at most) keeps
 * the old key working that long, so a running service can be moved to the new key without an
 * outage. Stopping at once is the default because the usual reason to rotate is a leak.
 *
 * The new key lives as long as the old one was made to (a 90 day key gets a fresh 90 days).
 */
export async function rotateApiKey(env: Env, actor: KeyActor, id: string, opts: { graceSeconds?: number } = {}, now = Date.now()): Promise<RotatedKey> {
  requireOwnSession(actor);
  const graceMs = (parse(rotateSchema, opts).graceSeconds ?? 0) * 1000;
  const old = await visibleKey(env, actor, id);
  if (old.kind === 'service') requireAdmin(actor, 'Only workspace admins can rotate a service account’s keys. Ask an admin for access.');
  else if (!ownsKey(actor, old)) throw errors.forbidden('Only the member a key belongs to can rotate it. You can revoke it instead.');

  const status = keyStatus(old, now);
  if (status === 'revoked') throw keyErrors.revoked();
  if (status === 'expired') throw keyErrors.expired();
  if (old.replaced_by !== null) throw keyErrors.already_rotated();

  // A member who was Admin when the key was made may be a Member now. The new key gets the weaker of the two.
  const role = old.kind === 'service' ? rowRole(old) : weakerRole(rowRole(old), capRole(actor.role));
  const nextId = newId('key', now);
  const oldEnds = graceMs > 0 ? Math.min(old.expires_at ?? Infinity, now + graceMs) : old.expires_at;

  const { row, secret } = await withNewKey(env, async (key, hash) => {
    const fresh: KeyRow = {
      ...old,
      id: nextId,
      prefix: key.prefix,
      key_hash: hash,
      role,
      expires_at: old.expires_at === null ? null : now + (old.expires_at - old.created_at),
      created_by: actor.userId,
      created_by_label: actor.label ?? null,
      created_at: now,
      last_used_at: null,
      last_used_ip: null,
      rotated_from: old.id,
    };
    const stillLive = 'org_id = ?1 AND id = ?2 AND revoked_at IS NULL AND replaced_by IS NULL';
    const retire =
      graceMs > 0
        ? env.DB.prepare(`UPDATE api_keys SET replaced_by = ?3, expires_at = ?4 WHERE ${stillLive}`).bind(actor.orgId, old.id, nextId, oldEnds)
        : env.DB.prepare(`UPDATE api_keys SET replaced_by = ?3, revoked_at = ?4, revoked_reason = 'rotated' WHERE ${stillLive}`).bind(actor.orgId, old.id, nextId, now);
    const [inserted] = await env.DB.batch([insertKeyStatement(env, fresh, old.id), retire]);
    // Nothing was written: another rotation of the same key finished first.
    if ((inserted?.meta.changes ?? 0) === 0) throw keyErrors.already_rotated();
    return { row: fresh, secret: key.secret };
  });

  const previous: KeyRow =
    graceMs > 0 ? { ...old, replaced_by: nextId, expires_at: oldEnds } : { ...old, replaced_by: nextId, revoked_at: now, revoked_reason: 'rotated' };
  await auditKeys(env, actor, {
    action: 'api_key.rotated',
    targetType: 'api_key',
    targetId: old.id,
    summary:
      graceMs > 0
        ? `Rotated the key ${old.name}. The old key works until its grace time ends`
        : `Rotated the key ${old.name}. The old key stopped working`,
    meta: { prefix: old.prefix, newKeyId: nextId, newPrefix: row.prefix, oldKeyEndsAt: graceMs > 0 ? oldEnds : now },
  });
  return { key: toApiKey(row, now), secret, previous: toApiKey(previous, now) };
}
