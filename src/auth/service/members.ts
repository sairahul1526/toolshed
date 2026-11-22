/**
 * The people in a workspace: listing them, changing a role, removing someone, leaving.
 *
 * A workspace always keeps at least one owner. That rule is part of the statement that makes
 * the change, so two requests racing each other cannot both take the last owner away.
 */
import type { Context } from 'hono';
import { lowerDemotedKeysStatement, recordKeysLowered, recordKeysRevoked, revokeLeaverKeysStatement } from '../../core/keys/members';
import type { AppEnv, Env, Role } from '../../env';
import { roleAtLeast } from '../../env';
import { authErrors } from '../errors';
import { auditBy, workspaceActor, type WorkspaceActor } from './actor';
import { assertMayAssign, isLowered, isRole, parseRole, ROLE_NAMES } from './roles';

export interface Member {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: Role;
  /** When they joined, ms. */
  joinedAt: number;
  isYou: boolean;
  /** Admins and owners only (null for everyone else): is two-step sign-in on, how many passkeys, last seen (ms). */
  twoStep: boolean | null;
  passkeys: number | null;
  lastSeenAt: number | null;
}

interface MemberRow {
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: string;
  createdAt: string;
  twoStep: number | null;
  passkeys: number;
  lastSeen: string | null;
}

/** Everyone in the active workspace, oldest member first. One query. */
export async function listMembers(c: Context<AppEnv>): Promise<Member[]> {
  const actor = await workspaceActor(c);
  const { results } = await c.env.DB.prepare(
    `SELECT m."userId" AS userId, u."name" AS name, u."email" AS email, u."image" AS image, m."role" AS role, m."createdAt" AS createdAt,
            u."twoFactorEnabled" AS twoStep,
            (SELECT COUNT(*) FROM "passkey" p WHERE p."userId" = m."userId") AS passkeys,
            (SELECT MAX(s."updatedAt") FROM "session" s WHERE s."userId" = m."userId" AND s."impersonatedBy" IS NULL) AS lastSeen
       FROM "member" m JOIN "user" u ON u."id" = m."userId"
      WHERE m."organizationId" = ?1 ORDER BY m."createdAt", m."id" LIMIT 500`,
  )
    .bind(actor.orgId)
    .all<MemberRow>();
  const full = roleAtLeast(actor.role, 'admin');
  return results.flatMap((r) =>
    isRole(r.role)
      ? [
          {
            userId: r.userId,
            name: r.name,
            email: r.email,
            image: r.image,
            role: r.role,
            joinedAt: Date.parse(r.createdAt),
            isYou: r.userId === actor.id,
            twoStep: full ? !!r.twoStep : null,
            passkeys: full ? r.passkeys : null,
            lastSeenAt: full && r.lastSeen ? Date.parse(r.lastSeen) : null,
          },
        ]
      : [],
  );
}

interface Target {
  name: string;
  email: string;
  role: Role;
}

async function memberOf(env: Env, orgId: string, userId: string): Promise<Target> {
  const row = await env.DB.prepare(
    `SELECT u."name" AS name, u."email" AS email, m."role" AS role FROM "member" m JOIN "user" u ON u."id" = m."userId" WHERE m."organizationId" = ?1 AND m."userId" = ?2`,
  )
    .bind(orgId, typeof userId === 'string' ? userId : '')
    .first<{ name: string; email: string; role: string }>();
  if (!row || !isRole(row.role)) throw authErrors.not_member();
  return { name: row.name, email: row.email, role: row.role };
}

/** Part of every change: the target still has the role we read, and it is not the last owner going. */
const STILL_SAFE = `"organizationId" = ?1 AND "userId" = ?2 AND "role" = ?3
  AND (?3 <> 'owner' OR (SELECT COUNT(*) FROM "member" WHERE "organizationId" = ?1 AND "role" = 'owner') > 1)`;
/** And the person making it still holds the role we checked. */
const ACTOR_STILL = `EXISTS (SELECT 1 FROM "member" a WHERE a."organizationId" = ?1 AND a."userId" = ?4 AND a."role" = ?5)`;

/** Why a guarded change touched nothing: the last owner was going, or something changed under us. */
async function refusal(env: Env, orgId: string, userId: string, was: Role) {
  const now = await env.DB.prepare(
    `SELECT (SELECT "role" FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2) AS role,
            (SELECT COUNT(*) FROM "member" WHERE "organizationId" = ?1 AND "role" = 'owner') AS owners`,
  )
    .bind(orgId, userId)
    .first<{ role: string | null; owners: number }>();
  if (!now?.role) return authErrors.not_member();
  if (was === 'owner' && now.role === 'owner' && now.owners <= 1) return authErrors.last_owner();
  return authErrors.role_needed();
}

/**
 * What follows a person losing their place: they stop being "in" the workspace on every device,
 * and the invites they sent stop working. Their personal API keys were already revoked, in the
 * same step that removed them.
 */
async function afterGone(env: Env, orgId: string, userId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE "session" SET "activeOrganizationId" =
         (SELECT m."organizationId" FROM "member" m WHERE m."userId" = ?2 ORDER BY m."createdAt", m."id" LIMIT 1)
        WHERE "userId" = ?2 AND "activeOrganizationId" = ?1`,
    ).bind(orgId, userId),
    env.DB.prepare(`UPDATE "invitation" SET "status" = 'canceled' WHERE "organizationId" = ?1 AND "inviterId" = ?2 AND "status" = 'pending'`).bind(orgId, userId),
  ]);
}

/**
 * Give a member of the active workspace another role. Admins and owners only; only an owner can
 * make or unmake an owner; nobody changes their own role.
 */
export async function changeMemberRole(c: Context<AppEnv>, userId: string, role: string): Promise<{ userId: string; role: Role; changed: boolean }> {
  const actor = await workspaceActor(c, 'admin');
  // A role given during a "sign in as" hour would outlast it.
  if (actor.impersonatedBy) throw authErrors.impersonating();
  const next = parseRole(role);
  if (userId === actor.id) throw authErrors.role_self();
  const target = await memberOf(c.env, actor.orgId, userId);
  assertMayAssign(actor.role, target.role, next);
  if (target.role === next) return { userId, role: next, changed: false };

  // Keys made with the old role must not outlive it, not even for the moment between two
  // statements, so they come down in the same batch as the role.
  const lowerKeys = isLowered(target.role, next) ? lowerDemotedKeysStatement(c.env, actor.orgId, userId, next) : null;
  const [done, lowered] = await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE "member" SET "role" = ?6 WHERE ${STILL_SAFE} AND ${ACTOR_STILL}`).bind(actor.orgId, userId, target.role, actor.id, actor.role, next),
    ...(lowerKeys ? [lowerKeys] : []),
  ]);
  if (done?.meta.changes !== 1) throw await refusal(c.env, actor.orgId, userId, target.role);
  if (lowered) await recordKeysLowered(c.env, actor.orgId, userId, next, lowered.meta.changes ?? 0);

  if (isLowered(target.role, next)) {
    // Invites made with the old role must not outlive it either.
    await c.env.DB.prepare(
      `UPDATE "invitation" SET "status" = 'canceled' WHERE "organizationId" = ?1 AND "inviterId" = ?2 AND "status" = 'pending' AND (?3 = 1 OR "role" = 'owner')`,
    )
      .bind(actor.orgId, userId, roleAtLeast(next, 'admin') ? 0 : 1)
      .run();
  }
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'member.role_changed',
    targetType: 'user',
    targetId: userId,
    summary: `Changed ${target.email} from ${ROLE_NAMES[target.role]} to ${ROLE_NAMES[next]}`,
    meta: { from: target.role, to: next },
  });
  return { userId, role: next, changed: true };
}

async function takeOut(c: Context<AppEnv>, actor: WorkspaceActor, userId: string, was: Role): Promise<void> {
  // One batch: there is no moment when the person is out and their keys still work.
  const [done, revoked] = await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM "member" WHERE ${STILL_SAFE} AND ${ACTOR_STILL}`).bind(actor.orgId, userId, was, actor.id, actor.role),
    revokeLeaverKeysStatement(c.env, actor.orgId, userId),
  ]);
  if (done?.meta.changes !== 1) throw await refusal(c.env, actor.orgId, userId, was);
  await recordKeysRevoked(c.env, actor.orgId, userId, revoked?.meta.changes ?? 0);
  await afterGone(c.env, actor.orgId, userId);
}

/**
 * Remove someone from the active workspace. Admins and owners only, and only an owner can remove
 * an owner. Their account stays; they lose this workspace on every device right away.
 */
export async function removeMember(c: Context<AppEnv>, userId: string): Promise<void> {
  const actor = await workspaceActor(c, 'admin');
  // Leaving is its own action, with its own wording on the screen.
  if (userId === actor.id) throw authErrors.self_action();
  const target = await memberOf(c.env, actor.orgId, userId);
  assertMayAssign(actor.role, target.role, null);
  await takeOut(c, actor, userId, target.role);
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'member.removed',
    targetType: 'user',
    targetId: userId,
    summary: `Removed ${target.email} from the workspace`,
    meta: { role: target.role },
  });
}

/** Leave the active workspace. The last owner cannot leave: someone else must be made an owner first. */
export async function leaveWorkspace(c: Context<AppEnv>): Promise<void> {
  const actor = await workspaceActor(c);
  if (actor.impersonatedBy) throw authErrors.impersonating();
  await takeOut(c, actor, actor.id, actor.role);
  await auditBy(c.env, actor, {
    orgId: actor.orgId,
    action: 'member.left',
    targetType: 'user',
    targetId: actor.id,
    summary: `${actor.email} left the workspace`,
    meta: { role: actor.role },
  });
}
