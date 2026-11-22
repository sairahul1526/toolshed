/**
 * Removing an account, for the two services that do it: the person themselves and the owner of
 * the install. Nothing here checks who is asking. The rules that protect everyone else (a
 * workspace keeps an owner, the install keeps an owner) are part of the delete statement itself,
 * so two requests racing each other cannot both get through.
 */
import { revokeKeysForUser } from '../core/keys/members';
import type { Env } from '../env';

/** True in SQL when user ?1 is the only owner of at least one workspace. */
const SOLE_OWNER = `EXISTS (SELECT 1 FROM "member" m WHERE m."userId" = ?1 AND m."role" = 'owner'
    AND NOT EXISTS (SELECT 1 FROM "member" o WHERE o."organizationId" = m."organizationId" AND o."role" = 'owner' AND o."userId" <> ?1))`;

/** True in SQL when user ?1 owns the install and nobody else does. */
const LAST_INSTANCE_OWNER = `(EXISTS (SELECT 1 FROM "user" x WHERE x."id" = ?1 AND x."role" = 'admin')
    AND NOT EXISTS (SELECT 1 FROM "user" y WHERE y."role" = 'admin' AND y."id" <> ?1))`;

export interface BlockingWorkspace {
  id: string;
  name: string;
  slug: string;
}

/** The workspaces that would be left without an owner if this person went. */
export async function soleOwnerOf(env: Env, userId: string): Promise<BlockingWorkspace[]> {
  const { results } = await env.DB.prepare(
    `SELECT o."id" AS id, o."name" AS name, o."slug" AS slug
       FROM "member" m JOIN "organization" o ON o."id" = m."organizationId"
      WHERE m."userId" = ?1 AND m."role" = 'owner'
        AND NOT EXISTS (SELECT 1 FROM "member" x WHERE x."organizationId" = m."organizationId" AND x."role" = 'owner' AND x."userId" <> ?1)
      ORDER BY o."name" LIMIT 50`,
  )
    .bind(userId)
    .all<BlockingWorkspace>();
  return results;
}

async function isLastInstanceOwner(env: Env, userId: string): Promise<boolean> {
  return !!(await env.DB.prepare(`SELECT 1 AS yes WHERE ${LAST_INSTANCE_OWNER}`).bind(userId).first<{ yes: number }>());
}

/** Tables with a row per person. The database removes these with the account; naming them keeps that true wherever it runs. */
const PERSONAL_TABLES = ['session', 'account', 'twoFactor', 'passkey', 'member'] as const;

/** `refused` means the caller's own `guard` said no, or the account was already gone. */
export type EraseOutcome = 'done' | 'sole_owner' | 'last_instance_owner' | 'refused';

/**
 * Delete an account and everything that signs it in. Nothing is deleted while the person is the
 * only owner of a workspace or of the install, or when `guard` (extra SQL, binds numbered from
 * ?2) says no.
 *
 * Their personal API keys are revoked first. If the delete is then refused by a request racing
 * this one, the keys stay revoked: a key that stops early is safer than one that outlives its
 * person.
 */
export async function eraseUser(env: Env, user: { id: string; email: string }, guard?: { sql: string; binds: string[] }): Promise<EraseOutcome> {
  if ((await soleOwnerOf(env, user.id)).length > 0) return 'sole_owner';
  if (await isLastInstanceOwner(env, user.id)) return 'last_instance_owner';

  // Only the workspaces where they hold a live key, so a person in many workspaces costs no more.
  const { results: keyed } = await env.DB.prepare(
    `SELECT DISTINCT org_id AS orgId FROM api_keys WHERE kind = 'personal' AND user_id = ?1 AND revoked_at IS NULL LIMIT 20`,
  )
    .bind(user.id)
    .all<{ orgId: string }>();
  for (const { orgId } of keyed) await revokeKeysForUser(env, orgId, user.id);

  const gone = `NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = ?1)`;
  const [removed] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM "user" WHERE "id" = ?1 AND NOT ${SOLE_OWNER} AND NOT ${LAST_INSTANCE_OWNER}${guard ? ` AND ${guard.sql}` : ''}`).bind(user.id, ...(guard?.binds ?? [])),
    ...PERSONAL_TABLES.map((table) => env.DB.prepare(`DELETE FROM "${table}" WHERE "userId" = ?1 AND ${gone}`).bind(user.id)),
    // Invites they sent die with their right to invite. "Sign in as" sessions they started end too.
    env.DB.prepare(`DELETE FROM "invitation" WHERE "inviterId" = ?1 AND ${gone}`).bind(user.id),
    env.DB.prepare(`DELETE FROM "session" WHERE "impersonatedBy" = ?1 AND ${gone}`).bind(user.id),
    // Half-finished two-step sign-ins and trusted browsers are kept by user id.
    env.DB.prepare(`DELETE FROM "verification" WHERE "value" = ?1 AND ${gone}`).bind(user.id),
    env.DB.prepare(`DELETE FROM auth_codes WHERE (email = ?2 OR ref = ?1) AND ${gone}`).bind(user.id, user.email),
  ]);
  return (removed?.meta.changes ?? 0) > 0 ? 'done' : 'refused';
}
