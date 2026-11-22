/**
 * Workspaces: making one, listing the ones a person is in, and choosing the active one. The
 * rows live in Better Auth's `organization` and `member` tables; the rules live here.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { newId } from '../../core/db';
import { parse } from '../../core/errors';
import { getSetting, INSTANCE } from '../../core/settings';
import type { AppEnv, Env, Role } from '../../env';
import { ROLES } from '../../env';
import { authErrors } from '../errors';
import { actorFrom, auditBy, isInstanceOwner } from './actor';

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  /** The asking person's role in it. */
  role: Role;
  /** When it was made, ms. */
  createdAt: number;
}

/** Instance setting: may people other than the owner of the install create workspaces? Off by default. */
export const MEMBERS_CAN_CREATE_KEY = 'auth.members_can_create_workspaces';
/** One person can own this many workspaces. Stops a script filling the database. */
export const MAX_OWNED_WORKSPACES = 25;

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

/** A short name made from a workspace name: "Acme Tools, Inc." becomes "acme-tools-inc". */
export function slugFrom(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)
    .replace(/-+$/, '');
  return slug || 'workspace';
}

const isRole = (value: string): value is Role => (ROLES as readonly string[]).includes(value);
const isUniqueClash = (err: unknown) => /UNIQUE/i.test(String((err as Error)?.message));

/** A free short name starting with `base`: the base itself, then base-2, base-3 and so on. */
async function freeSlug(env: Env, base: string): Promise<string> {
  const { results } = await env.DB.prepare(`SELECT "slug" FROM "organization" WHERE "slug" = ?1 OR "slug" LIKE ?2 LIMIT 200`)
    .bind(base, `${base}-%`)
    .all<{ slug: string }>();
  const taken = new Set(results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n <= 200; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
  return `${base}-${newId('x').slice(-6).toLowerCase()}`;
}

/** True when this person may create a workspace: the owner of the install always, others only when the install allows it. */
export async function mayCreateWorkspace(env: Env, userId: string): Promise<boolean> {
  if (await isInstanceOwner(env, userId)) return true;
  return (await getSetting<boolean>(env, INSTANCE, MEMBERS_CAN_CREATE_KEY, false)) === true;
}

/**
 * Create a workspace with the asking person as its owner, and make it their active one. Leave
 * `slug` out to get one made from the name.
 */
export async function createWorkspace(c: Context<AppEnv>, input: { name: string; slug?: string | null }): Promise<Workspace> {
  const actor = await actorFrom(c);
  const { name } = parse(z.object({ name: workspaceNameSchema }), { name: input.name });
  const typed = typeof input.slug === 'string' ? input.slug.trim() : '';
  const explicit = typed ? parse(z.object({ slug: slugSchema }), { slug: typed }).slug : null;
  if (!(await mayCreateWorkspace(c.env, actor.id))) throw authErrors.workspace_create_off();

  const owned = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM "member" WHERE "userId" = ?1 AND "role" = 'owner'`).bind(actor.id).first<{ n: number }>();
  if ((owned?.n ?? 0) >= MAX_OWNED_WORKSPACES) throw authErrors.workspace_limit();

  const slug = explicit ?? (await freeSlug(c.env, slugFrom(name)));
  const now = Date.now();
  const iso = new Date(now).toISOString();
  const id = newId('org', now);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare('INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (?1, ?2, ?3, ?4)').bind(id, name, slug, iso),
      c.env.DB.prepare(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES (?1, ?2, ?3, 'owner', ?4)`).bind(newId('mem', now), id, actor.id, iso),
      c.env.DB.prepare('UPDATE "session" SET "activeOrganizationId" = ?1 WHERE "id" = ?2').bind(id, actor.sessionId),
    ]);
  } catch (err) {
    // Two people taking the same short name at once: the unique index decides.
    if (isUniqueClash(err)) throw authErrors.slug_taken();
    throw err;
  }
  await auditBy(c.env, actor, { orgId: id, action: 'workspace.created', targetType: 'workspace', targetId: id, summary: `Created the workspace ${name}`, meta: { slug } });
  return { id, name, slug, role: 'owner', createdAt: now };
}

/** Every workspace the asking person is in, oldest first. One query. */
export async function listWorkspaces(c: Context<AppEnv>): Promise<Workspace[]> {
  const actor = await actorFrom(c);
  return workspacesOf(c.env, actor.id);
}

/** Every workspace a person is in. For code that already knows who is asking. */
export async function workspacesOf(env: Env, userId: string): Promise<Workspace[]> {
  const { results } = await env.DB.prepare(
    `SELECT o."id" AS id, o."name" AS name, o."slug" AS slug, o."createdAt" AS createdAt, m."role" AS role
       FROM "member" m JOIN "organization" o ON o."id" = m."organizationId"
      WHERE m."userId" = ?1 ORDER BY m."createdAt", m."id" LIMIT 200`,
  )
    .bind(userId)
    .all<{ id: string; name: string; slug: string; createdAt: string; role: string }>();
  return results.flatMap((r) => (isRole(r.role) ? [{ id: r.id, name: r.name, slug: r.slug, role: r.role, createdAt: Date.parse(r.createdAt) }] : []));
}

/** Make another workspace the active one for this browser. Only a workspace the person is in. */
export async function switchWorkspace(c: Context<AppEnv>, workspaceId: string): Promise<Workspace> {
  const actor = await actorFrom(c);
  const target = (await workspacesOf(c.env, actor.id)).find((w) => w.id === workspaceId);
  // Not saying whether the workspace exists: to someone outside it, it does not.
  if (!target) throw authErrors.workspace_not_found();
  await c.env.DB.prepare('UPDATE "session" SET "activeOrganizationId" = ?1 WHERE "id" = ?2 AND "userId" = ?3').bind(target.id, actor.sessionId, actor.id).run();
  return target;
}
