/**
 * What happens to personal keys when their member changes. The members code calls these;
 * nothing here checks permissions, because the caller already decided the member is leaving
 * or changing role.
 */
import type { Env, Role } from '../../env';
import { roleAtLeast } from '../../env';
import { audit } from '../audit';
import { capRole, KEY_ROLES, roleName } from './shared';
import type { KeyRole } from './shared';

const REVOKE = `UPDATE api_keys SET revoked_at = ?3, revoked_reason = 'member_removed'
  WHERE org_id = ?1 AND kind = 'personal' AND user_id = ?2 AND revoked_at IS NULL`;

/** Write down a revoke that already happened. Returns `changes`. */
export async function recordKeysRevoked(env: Env, orgId: string, userId: string, changes: number): Promise<number> {
  if (changes > 0) {
    await audit(env, {
      orgId,
      actorType: 'system',
      action: 'api_key.revoked',
      targetType: 'user',
      targetId: userId,
      summary: `Revoked ${changes} ${changes === 1 ? 'key' : 'keys'} because their owner left the workspace`,
      meta: { reason: 'member_removed', count: changes },
    });
  }
  return changes;
}

/**
 * Revoke every personal key of a member who left or was removed. Service account keys are
 * untouched: they belong to the workspace. Returns how many keys stopped working.
 */
export async function revokeKeysForUser(env: Env, orgId: string, userId: string, now = Date.now()): Promise<number> {
  const done = await env.DB.prepare(REVOKE).bind(orgId, userId, now).run();
  return recordKeysRevoked(env, orgId, userId, done.meta.changes ?? 0);
}

/**
 * The same revoke as one statement, to batch right after the DELETE of the membership so the
 * two happen together or not at all. It acts only once the membership is gone, so a removal
 * that was refused revokes nothing. Pass its `meta.changes` to `recordKeysRevoked`.
 */
export function revokeLeaverKeysStatement(env: Env, orgId: string, userId: string, now = Date.now()): D1PreparedStatement {
  return env.DB.prepare(`${REVOKE} AND NOT EXISTS (SELECT 1 FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2)`).bind(orgId, userId, now);
}

/** Roles a key must come down from when its owner now holds `role`. */
function strongerThan(role: Role): { ceiling: KeyRole; stronger: KeyRole[] } {
  const ceiling = capRole(role);
  return { ceiling, stronger: KEY_ROLES.filter((r) => r !== ceiling && roleAtLeast(r, ceiling)) };
}

function lowerSql(stronger: KeyRole[]): string {
  return `UPDATE api_keys SET role = ?3
  WHERE org_id = ?1 AND kind = 'personal' AND user_id = ?2 AND revoked_at IS NULL AND role IN (${stronger.map((_, i) => `?${i + 4}`).join(', ')})`;
}

/** Write down a lowering that already happened. Returns `changes`. */
export async function recordKeysLowered(env: Env, orgId: string, userId: string, role: Role, changes: number): Promise<number> {
  const ceiling = capRole(role);
  if (changes > 0) {
    await audit(env, {
      orgId,
      actorType: 'system',
      action: 'api_key.role_lowered',
      targetType: 'user',
      targetId: userId,
      summary: `Lowered ${changes} ${changes === 1 ? 'key' : 'keys'} to ${roleName(ceiling)} because their owner’s role changed`,
      meta: { role: ceiling, count: changes },
    });
  }
  return changes;
}

/**
 * Lower a member's personal keys to their new role after a demotion, so an old Admin key does
 * not keep Admin rights. Keys already at or below the new role are untouched, and a promotion
 * never raises a key. Returns how many keys were lowered.
 */
export async function limitKeysForUser(env: Env, orgId: string, userId: string, role: Role): Promise<number> {
  const { ceiling, stronger } = strongerThan(role);
  if (stronger.length === 0) return 0;
  const done = await env.DB.prepare(lowerSql(stronger)).bind(orgId, userId, ceiling, ...stronger).run();
  return recordKeysLowered(env, orgId, userId, role, done.meta.changes ?? 0);
}

/**
 * The same lowering as one statement, to batch right after the UPDATE of the membership. It acts
 * only when the member really holds `role` now, so a change that was refused lowers nothing.
 * Null when no key could be stronger than `role`. Pass its `meta.changes` to `recordKeysLowered`.
 */
export function lowerDemotedKeysStatement(env: Env, orgId: string, userId: string, role: Role): D1PreparedStatement | null {
  const { ceiling, stronger } = strongerThan(role);
  if (stronger.length === 0) return null;
  const guard = `EXISTS (SELECT 1 FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2 AND "role" = ?${stronger.length + 4})`;
  return env.DB.prepare(`${lowerSql(stronger)} AND ${guard}`).bind(orgId, userId, ceiling, ...stronger, role);
}
