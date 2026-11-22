/**
 * What the owner of the install can do to any account or workspace: look people up, suspend
 * them, delete them, sign in as them for a short while, and rename or delete any workspace.
 *
 * Every function checks ownership against the database for itself, refuses a "sign in as"
 * session, and puts the same check inside the statement that makes the change. The owner's own
 * account and other owners are out of reach of all of it.
 */
import type { Context } from 'hono';
import { z } from 'zod';
import { audit, likeEscape } from '../../core/audit';
import { errors, parse } from '../../core/errors';
import type { AppEnv } from '../../env';
import { getAuth } from '../auth';
import { callAuth } from '../bridge';
import { BAN_DAYS, IMPERSONATION_TTL_SEC } from '../config';
import { authErrors } from '../errors';
import { enforceHit, forwardCookies } from '../http';
import { recordImpersonationEnd } from '../impersonation';
import { sessionFromRequest } from '../session';
import { clearSessionCookies } from '../signin';
import { eraseUser } from '../user-store';
import { findUserById, isBanned, type UserRow } from '../users';
import { eraseWorkspace, findWorkspace, saveWorkspaceName } from '../workspace-store';
import { actorFrom, auditBy, freshFrom, selfFrom, type SignedIn } from './actor';
import { workspacesOf, type Workspace } from './workspaces';

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE = 50;

/** True in SQL when the user bound at `?n` still owns the install. */
const stillOwner = (n: number) => `EXISTS (SELECT 1 FROM "user" a WHERE a."id" = ?${n} AND a."role" = 'admin')`;

/** The owner of the install, as themselves. `fresh` also asks for a recent sign-in. */
async function ownerFrom(c: Context<AppEnv>, opts: { fresh?: boolean } = {}): Promise<SignedIn> {
  const actor = opts.fresh ? await freshFrom(c) : await selfFrom(c);
  const row = await c.env.DB.prepare(`SELECT 1 AS yes WHERE ${stillOwner(1)}`).bind(actor.id).first<{ yes: number }>();
  if (!row) throw authErrors.owner_only();
  return actor;
}

/** Someone the owner may act on: an account that exists, is not their own and does not own the install. */
async function targetFor(c: Context<AppEnv>, actor: SignedIn, userId: string): Promise<UserRow> {
  const user = await findUserById(c.env, typeof userId === 'string' ? userId : '');
  if (!user) throw authErrors.user_not_found();
  if (user.id === actor.id) throw authErrors.self_action();
  if (user.role === 'admin') throw authErrors.is_owner();
  return user;
}

/* ---- People ---- */

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  username: string | null;
  image: string | null;
  isInstanceOwner: boolean;
  isYou: boolean;
  /** Suspended right now. */
  banned: boolean;
  banReason: string | null;
  /** When the suspension lifts by itself, ms. Null means until someone lifts it. */
  banExpiresAt: number | null;
  twoStep: boolean;
  passkeys: number;
  /** How many workspaces they are in. */
  workspaces: number;
  createdAt: number;
  /** Last use of any of their sessions, ms. Null when they are signed out everywhere. */
  lastSeenAt: number | null;
}

interface AdminUserRow extends UserRow {
  image: string | null;
  passkeys: number;
  workspaces: number;
  lastSeen: string | null;
}

const USER_SELECT = `SELECT u."id", u."email", u."name", u."username", u."image", u."role", u."banned", u."banReason", u."banExpires", u."twoFactorEnabled", u."createdAt",
            (SELECT COUNT(*) FROM "passkey" p WHERE p."userId" = u."id") AS passkeys,
            (SELECT COUNT(*) FROM "member" m WHERE m."userId" = u."id") AS workspaces,
            (SELECT MAX(s."updatedAt") FROM "session" s WHERE s."userId" = u."id" AND s."impersonatedBy" IS NULL) AS lastSeen
       FROM "user" u`;

function toAdminUser(row: AdminUserRow, actorId: string, now: number): AdminUser {
  const banned = isBanned(row, now);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    username: row.username,
    image: row.image,
    isInstanceOwner: row.role === 'admin',
    isYou: row.id === actorId,
    banned,
    banReason: banned ? row.banReason : null,
    banExpiresAt: banned && row.banExpires ? Date.parse(row.banExpires) : null,
    twoStep: !!row.twoFactorEnabled,
    passkeys: row.passkeys,
    workspaces: row.workspaces,
    createdAt: Date.parse(row.createdAt),
    lastSeenAt: row.lastSeen ? Date.parse(row.lastSeen) : null,
  };
}

export interface ListInput {
  /** Matches part of a name, email or username (people), or a name or short name (workspaces). */
  query?: string | null;
  /** `nextCursor` from the page before. */
  cursor?: string | null;
  /** Rows per page: 1 to 100, 50 when left out. */
  limit?: number | null;
}

export interface Page<T> {
  items: T[];
  /** Pass back as `cursor` for the next page. Null on the last page. */
  nextCursor: string | null;
}

/** Newest first, with a cursor made of the row's creation time and id. */
function paging(input: ListInput): { like: string; at: string; id: string; limit: number } {
  const query = typeof input.query === 'string' ? input.query.trim().slice(0, 100) : '';
  const limit = Math.min(100, Math.max(1, Math.trunc(Number(input.limit) || PAGE)));
  const cursor = typeof input.cursor === 'string' ? input.cursor : '';
  const cut = cursor.indexOf('~');
  if (cursor && (cut < 1 || cursor.length > 120 || Number.isNaN(Date.parse(cursor.slice(0, cut))))) {
    throw errors.bad_request('That page marker isn’t valid. Reload the list.');
  }
  return { like: query ? `%${likeEscape(query)}%` : '', at: cursor.slice(0, Math.max(cut, 0)), id: cursor.slice(cut + 1), limit };
}

function pageOf<R extends { id: string; createdAt: string }, T>(rows: R[], limit: number, map: (row: R) => T): Page<T> {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(map), nextCursor: rows.length > limit && last ? `${last.createdAt}~${last.id}` : null };
}

/** Everyone with an account on this install, newest first. One query per page. */
export async function listUsers(c: Context<AppEnv>, input: ListInput = {}, now = Date.now()): Promise<Page<AdminUser>> {
  const actor = await ownerFrom(c);
  const page = paging(input);
  const { results } = await c.env.DB.prepare(
    `${USER_SELECT}
      WHERE (?1 = '' OR u."email" LIKE ?1 ESCAPE '\\' OR u."name" LIKE ?1 ESCAPE '\\' OR u."username" LIKE ?1 ESCAPE '\\')
        AND (?2 = '' OR u."createdAt" < ?2 OR (u."createdAt" = ?2 AND u."id" < ?3))
      ORDER BY u."createdAt" DESC, u."id" DESC LIMIT ?4`,
  )
    .bind(page.like, page.at, page.id, page.limit + 1)
    .all<AdminUserRow>();
  return pageOf(results, page.limit, (row) => toAdminUser(row, actor.id, now));
}

export interface AdminUserDetail extends AdminUser {
  /** Every workspace they are in, with their role there. */
  memberships: Workspace[];
}

/** One person, with the workspaces they are in. Two queries. */
export async function getUser(c: Context<AppEnv>, userId: string, now = Date.now()): Promise<AdminUserDetail> {
  const actor = await ownerFrom(c);
  const row = await c.env.DB.prepare(`${USER_SELECT} WHERE u."id" = ?1`).bind(typeof userId === 'string' ? userId : '').first<AdminUserRow>();
  if (!row) throw authErrors.user_not_found();
  return { ...toAdminUser(row, actor.id, now), memberships: await workspacesOf(c.env, row.id) };
}

const banSchema = z.object({
  reason: z.string().trim().max(200, 'Keep the reason under 200 characters.').optional(),
  days: z
    .union([z.literal(7), z.literal(30), z.null()], 'Pick 7 days, 30 days, or until lifted.')
    .optional()
    .refine((v) => v === undefined || (BAN_DAYS as readonly (number | null)[]).includes(v)),
});

/**
 * Suspend someone: they are signed out everywhere, cannot sign in, their API keys and tokens stop
 * working, and invites they sent are cancelled. `days` is 7, 30 or null (until lifted).
 */
export async function banUser(c: Context<AppEnv>, userId: string, input: { reason?: string; days?: number | null } = {}, now = Date.now()): Promise<{ userId: string; until: number | null }> {
  const actor = await ownerFrom(c);
  const target = await targetFor(c, actor, userId);
  const { reason, days } = parse(banSchema, { reason: input.reason, days: input.days ?? null });
  const until = days ? now + days * DAY_MS : null;
  const banned = `EXISTS (SELECT 1 FROM "user" b WHERE b."id" = ?1 AND b."banned" = 1)`;
  const [done] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE "user" SET "banned" = 1, "banReason" = ?2, "banExpires" = ?3, "updatedAt" = ?4
        WHERE "id" = ?1 AND COALESCE("role", 'user') <> 'admin' AND ${stillOwner(5)}`,
    ).bind(target.id, reason || null, until ? new Date(until).toISOString() : null, new Date(now).toISOString(), actor.id),
    c.env.DB.prepare(`DELETE FROM "session" WHERE "userId" = ?1 AND ${banned}`).bind(target.id),
    c.env.DB.prepare(`UPDATE "invitation" SET "status" = 'canceled' WHERE "inviterId" = ?1 AND "status" = 'pending' AND ${banned}`).bind(target.id),
  ]);
  if (done?.meta.changes !== 1) throw authErrors.owner_only();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'user.banned',
    targetType: 'user',
    targetId: target.id,
    summary: `Suspended ${target.email}${days ? ` for ${days} days` : ''}`,
    meta: { days: days ?? null, ...(reason ? { reason } : {}) },
  });
  return { userId: target.id, until };
}

/** Lift a suspension. The person can sign in again; sessions and invites that ended stay ended. */
export async function unbanUser(c: Context<AppEnv>, userId: string, now = Date.now()): Promise<void> {
  const actor = await ownerFrom(c);
  const target = await targetFor(c, actor, userId);
  const done = await c.env.DB.prepare(
    `UPDATE "user" SET "banned" = 0, "banReason" = NULL, "banExpires" = NULL, "updatedAt" = ?2 WHERE "id" = ?1 AND "banned" = 1 AND ${stillOwner(3)}`,
  )
    .bind(target.id, new Date(now).toISOString(), actor.id)
    .run();
  if (done.meta.changes !== 1) return;
  await auditBy(c.env, actor, { orgId: null, action: 'user.unbanned', targetType: 'user', targetId: target.id, summary: `Lifted the suspension of ${target.email}` });
}

/**
 * Delete someone's account for good. `confirm` must be their email address, typed out. Refused
 * while they are the only owner of a workspace (`auth.sole_owner`): give it another owner or
 * delete it first.
 */
export async function deleteUser(c: Context<AppEnv>, userId: string, input: { confirm: string }): Promise<void> {
  const actor = await ownerFrom(c, { fresh: true });
  const target = await targetFor(c, actor, userId);
  const typed = typeof input.confirm === 'string' ? input.confirm.trim().toLowerCase() : '';
  if (typed !== target.email) throw errors.validation_failed(undefined, { confirm: `Type ${target.email} to confirm.` });
  const outcome = await eraseUser(c.env, target, { sql: stillOwner(2), binds: [actor.id] });
  if (outcome === 'sole_owner') throw authErrors.sole_owner();
  if (outcome === 'last_instance_owner') throw authErrors.is_owner();
  if (outcome !== 'done') throw authErrors.owner_only();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'user.deleted',
    targetType: 'user',
    targetId: target.id,
    summary: `Deleted the account of ${target.email}`,
    meta: { email: target.email },
  });
}

/* ---- Sign in as ---- */

export interface Impersonation {
  /** The person the browser is signed in as. */
  user: { id: string; name: string; email: string };
  /** The owner who is really there. */
  by: { id: string; name: string; email: string };
  /** When the session ends by itself, ms. */
  expiresAt: number;
}

/**
 * Sign this browser in as someone else, for an hour at most, to see what they see. Needs a
 * recent sign-in. The owner's own session waits and comes back with `stopImpersonation`.
 * While it lasts, account changes are refused and every audit line carries the owner's id.
 */
export async function startImpersonation(c: Context<AppEnv>, userId: string, now = Date.now()): Promise<Impersonation> {
  const actor = await ownerFrom(c, { fresh: true });
  const target = await targetFor(c, actor, userId);
  if (isBanned(target, now)) throw authErrors.user_banned();
  // Without a workspace the dashboard (and its Stop button) can't open, so the owner would be stuck.
  const member = await c.env.DB.prepare('SELECT 1 AS n FROM "member" WHERE "userId" = ?1 LIMIT 1').bind(target.id).first<{ n: number }>();
  if (!member) throw authErrors.no_workspace_to_see();
  await enforceHit(c.env, 'impersonatePerOwner', actor.id);

  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth<{ session?: { id?: string; expiresAt?: string } }>(() =>
    auth.api.impersonateUser({ body: { userId: target.id }, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok || !reply.data?.session?.id) {
    if (reply.code === 'BANNED_USER') throw authErrors.user_banned();
    throw authErrors.owner_only();
  }
  forwardCookies(c, reply.cookies);
  const expiresAt = Date.parse(reply.data.session.expiresAt ?? '') || now + IMPERSONATION_TTL_SEC * 1000;
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'impersonation.started',
    targetType: 'user',
    targetId: target.id,
    summary: `Signed in as ${target.email}`,
    meta: { sessionId: reply.data.session.id, expiresAt },
  });
  return { user: { id: target.id, name: target.name, email: target.email }, by: { id: actor.id, name: actor.name, email: actor.email }, expiresAt };
}

/** Who is really behind this session, for the banner. Null in an ordinary session, which costs no query. */
export async function currentImpersonation(c: Context<AppEnv>): Promise<Impersonation | null> {
  const loaded = c.get('auth').kind === 'session' ? await sessionFromRequest(c) : null;
  const ownerId = loaded?.session.impersonatedBy;
  if (!loaded || !ownerId) return null;
  const owner = await findUserById(c.env, ownerId);
  return {
    user: { id: loaded.user.id, name: loaded.user.name, email: loaded.user.email },
    by: { id: ownerId, name: owner?.name ?? 'The owner', email: owner?.email ?? '' },
    expiresAt: loaded.session.expiresAt,
  };
}

/**
 * Stop being signed in as someone else and go back to the owner's own session. When that session
 * has ended in the meantime, the browser is signed out instead.
 */
export async function stopImpersonation(c: Context<AppEnv>): Promise<{ signedOut: boolean }> {
  const actor = await actorFrom(c);
  const ownerId = actor.impersonatedBy;
  if (!ownerId) throw authErrors.not_impersonating();

  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth(() => auth.api.stopImpersonating({ headers: c.req.raw.headers, asResponse: true }));
  if (reply.ok) {
    forwardCookies(c, reply.cookies);
  } else {
    await c.env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1').bind(actor.sessionId).run();
    clearSessionCookies(c);
  }
  await recordImpersonationEnd(c.env, ownerId, actor, actor.ip);
  return { signedOut: !reply.ok };
}

/* ---- Workspaces ---- */

export interface AdminWorkspace {
  id: string;
  name: string;
  slug: string;
  createdAt: number;
  members: number;
  /** Email addresses of its owners. */
  owners: string[];
}

interface AdminWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  members: number;
  owners: string | null;
}

/** Every workspace on this install, newest first. One query per page. */
export async function listAllWorkspaces(c: Context<AppEnv>, input: ListInput = {}): Promise<Page<AdminWorkspace>> {
  await ownerFrom(c);
  const page = paging(input);
  const { results } = await c.env.DB.prepare(
    `SELECT o."id" AS id, o."name" AS name, o."slug" AS slug, o."createdAt" AS createdAt,
            (SELECT COUNT(*) FROM "member" m WHERE m."organizationId" = o."id") AS members,
            (SELECT group_concat(u."email", char(10)) FROM "member" m JOIN "user" u ON u."id" = m."userId"
              WHERE m."organizationId" = o."id" AND m."role" = 'owner') AS owners
       FROM "organization" o
      WHERE (?1 = '' OR o."name" LIKE ?1 ESCAPE '\\' OR o."slug" LIKE ?1 ESCAPE '\\')
        AND (?2 = '' OR o."createdAt" < ?2 OR (o."createdAt" = ?2 AND o."id" < ?3))
      ORDER BY o."createdAt" DESC, o."id" DESC LIMIT ?4`,
  )
    .bind(page.like, page.at, page.id, page.limit + 1)
    .all<AdminWorkspaceRow>();
  return pageOf(results, page.limit, (row) => ({
    id: row.id,
    name: row.name,
    slug: row.slug,
    createdAt: Date.parse(row.createdAt),
    members: row.members,
    owners: row.owners ? row.owners.split('\n').sort() : [],
  }));
}

/** Rename any workspace and, when `slug` is given, change its short name. The workspace's own log records it. */
export async function renameAnyWorkspace(c: Context<AppEnv>, workspaceId: string, input: { name: string; slug?: string | null }): Promise<{ id: string; name: string; slug: string }> {
  const actor = await ownerFrom(c);
  const before = await findWorkspace(c.env, workspaceId);
  if (!before) throw authErrors.workspace_not_found();
  const after = await saveWorkspaceName(c.env, before, input, { sql: stillOwner(4), binds: [actor.id] });
  if (!after) throw authErrors.owner_only();
  if (after !== before) {
    await auditBy(c.env, actor, {
      orgId: before.id,
      action: 'workspace.renamed',
      targetType: 'workspace',
      targetId: before.id,
      summary: after.name === before.name ? `Changed the short name to ${after.slug}` : `Renamed the workspace to ${after.name}`,
      meta: { from: { name: before.name, slug: before.slug }, to: { name: after.name, slug: after.slug }, byInstanceOwner: true },
    });
  }
  return { id: after.id, name: after.name, slug: after.slug };
}

/**
 * Delete any workspace with everything in it. Needs a recent sign-in, and `confirm` must be the
 * workspace's short name, typed out. This cannot be undone.
 */
export async function deleteAnyWorkspace(c: Context<AppEnv>, workspaceId: string, input: { confirm: string }): Promise<void> {
  const actor = await ownerFrom(c, { fresh: true });
  const target = await findWorkspace(c.env, workspaceId);
  if (!target) throw authErrors.workspace_not_found();
  const typed = typeof input.confirm === 'string' ? input.confirm.trim().toLowerCase() : '';
  if (typed !== target.slug) throw errors.validation_failed(undefined, { confirm: `Type ${target.slug} to confirm.` });
  // Ownership was read for this request; read it once more right before the point of no return.
  await ownerFrom(c);
  await eraseWorkspace(c.env, target.id);
  await audit(c.env, {
    orgId: null,
    actorId: actor.id,
    actorLabel: actor.email,
    ip: actor.ip,
    action: 'workspace.deleted',
    targetType: 'workspace',
    targetId: target.id,
    summary: `Deleted the workspace ${target.name}`,
    meta: { slug: target.slug, byInstanceOwner: true },
  });
}
