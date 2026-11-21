/**
 * What happens to personal keys when their member changes. The members code calls these;
 * nothing here checks permissions, because the caller already decided the member is leaving
 * or changing role.
 */
import type { Env, Role } from '../../env';
import { roleAtLeast } from '../../env';
import { audit } from '../audit';
import { orgDb } from '../db';
import { capRole, KEY_ROLES, roleName } from './shared';

/**
 * Revoke every personal key of a member who left or was removed. Service account keys are
 * untouched: they belong to the workspace. Returns how many keys stopped working.
 */
export async function revokeKeysForUser(env: Env, orgId: string, userId: string, now = Date.now()): Promise<number> {
  const { changes } = await orgDb(env.DB, orgId).run(
    `UPDATE api_keys SET revoked_at = ?, revoked_reason = 'member_removed'
     WHERE org_id = :org AND kind = 'personal' AND user_id = ? AND revoked_at IS NULL`,
    now,
    userId,
  );
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
 * Lower a member's personal keys to their new role after a demotion, so an old Admin key does
 * not keep Admin rights. Keys already at or below the new role are untouched, and a promotion
 * never raises a key. Returns how many keys were lowered.
 */
export async function limitKeysForUser(env: Env, orgId: string, userId: string, role: Role): Promise<number> {
  const ceiling = capRole(role);
  const stronger = KEY_ROLES.filter((r) => r !== ceiling && roleAtLeast(r, ceiling));
  if (stronger.length === 0) return 0;
  const { changes } = await orgDb(env.DB, orgId).run(
    `UPDATE api_keys SET role = ?
     WHERE org_id = :org AND kind = 'personal' AND user_id = ? AND revoked_at IS NULL AND role IN (${stronger.map(() => '?').join(', ')})`,
    ceiling,
    userId,
    ...stronger,
  );
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
