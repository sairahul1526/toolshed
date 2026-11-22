/**
 * Changes to a workspace row that more than one service makes: a workspace's own admins, and the
 * owner of the install acting on any workspace. Nothing here checks who is asking. The service
 * functions that call these do.
 */
import { z } from 'zod';
import { parse } from '../core/errors';
import { purgeOrgFiles, purgeOrgStatements } from '../core/registry';
import type { Env } from '../env';
import { authErrors } from './errors';

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name for the workspace.')
  .max(60, 'Keep the name under 60 characters.')
  .refine((v) => !/[\u0000-\u001f\u007f<>]/.test(v), 'Use letters, numbers and simple punctuation only.');

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, 'Use 1 to 40 letters, numbers and dashes. Start and end with a letter or number.');

export const isUniqueClash = (err: unknown) => /UNIQUE/i.test(String((err as Error)?.message));

export interface WorkspaceRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

export function findWorkspace(env: Env, id: string): Promise<WorkspaceRow | null> {
  return env.DB.prepare(`SELECT "id", "name", "slug", "createdAt" FROM "organization" WHERE "id" = ?1`).bind(typeof id === 'string' ? id : '').first<WorkspaceRow>();
}

/**
 * Give a workspace a new name and, when `slug` is given, a new short name. `guard` is extra SQL
 * the row must still satisfy (with its binds numbered from ?4), so the caller's permission is part
 * of the statement. Returns the row as it now is, or null when the guard refused.
 */
export async function saveWorkspaceName(
  env: Env,
  current: WorkspaceRow,
  input: { name: string; slug?: string | null },
  guard?: { sql: string; binds: string[] },
): Promise<WorkspaceRow | null> {
  const { name } = parse(z.object({ name: workspaceNameSchema }), { name: input.name });
  const typed = typeof input.slug === 'string' ? input.slug.trim() : '';
  const slug = typed ? parse(z.object({ slug: slugSchema }), { slug: typed }).slug : current.slug;
  if (name === current.name && slug === current.slug) return current;
  try {
    const done = await env.DB.prepare(`UPDATE "organization" SET "name" = ?2, "slug" = ?3 WHERE "id" = ?1${guard ? ` AND ${guard.sql}` : ''}`)
      .bind(current.id, name, slug, ...(guard?.binds ?? []))
      .run();
    if (done.meta.changes !== 1) return null;
  } catch (err) {
    if (isUniqueClash(err)) throw authErrors.slug_taken();
    throw err;
  }
  return { ...current, name, slug };
}

/**
 * Delete a workspace and everything in it. Its files go first: if that fails the workspace is
 * still there and the delete can be run again. Then every row goes in ONE batch, the stored data
 * together with the members and the workspace itself, so there is no moment when the data is
 * gone but a member or a key can still write more into it. People who had it open move to
 * another of their workspaces, or to none.
 */
export async function eraseWorkspace(env: Env, orgId: string): Promise<void> {
  await purgeOrgFiles(env, orgId);
  await env.DB.batch([
    ...purgeOrgStatements(env, orgId),
    env.DB.prepare(
      `UPDATE "session" SET "activeOrganizationId" =
         (SELECT m."organizationId" FROM "member" m WHERE m."userId" = "session"."userId" AND m."organizationId" <> ?1 ORDER BY m."createdAt", m."id" LIMIT 1)
        WHERE "activeOrganizationId" = ?1`,
    ).bind(orgId),
    env.DB.prepare(`DELETE FROM "invitation" WHERE "organizationId" = ?1`).bind(orgId),
    env.DB.prepare(`DELETE FROM "member" WHERE "organizationId" = ?1`).bind(orgId),
    env.DB.prepare(`DELETE FROM "organization" WHERE "id" = ?1`).bind(orgId),
  ]);
}
