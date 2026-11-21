/**
 * Reads who is making a request. This runs on every signed-in page view, so it does not start
 * Better Auth at all: it checks the signed session cookie itself and loads the session, the person
 * and their role in the active workspace with ONE joined query. A second query runs at most once
 * an hour per session, to push the expiry forward and record "last seen".
 */
import type { Context } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { ActiveOrg, AppEnv, Env, Role, SessionUser } from '../env';
import { ROLES } from '../env';
import { baseUrl, COOKIE_PREFIX, secureCookies } from './auth';
import { SESSION_REFRESH_SEC, SESSION_TTL_SEC } from './config';
import { verifyBase64Hmac } from './crypto';

export interface SessionInfo {
  id: string;
  /** When this session was started, ms. */
  createdAt: number;
  expiresAt: number;
  /** The instance owner's user id while they are signed in as someone else. */
  impersonatedBy: string | null;
}

export interface LoadedSession {
  session: SessionInfo;
  user: SessionUser;
  org: ActiveOrg | null;
}

interface SessionRow {
  sid: string;
  token: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  impersonatedBy: string | null;
  uid: string;
  email: string;
  name: string;
  image: string | null;
  urole: string | null;
  banned: number | null;
  banExpires: string | null;
  oid: string | null;
  oname: string | null;
  oslug: string | null;
  mrole: string | null;
}

/** The session cookie's name for this origin. `__Secure-` is added wherever cookies are Secure. */
export function sessionCookieName(origin: string): string {
  return `${secureCookies(origin) ? '__Secure-' : ''}${COOKIE_PREFIX}.session_token`;
}

/**
 * The session token from a signed cookie value (`<token>.<base64 HMAC-SHA256>`), or null when the
 * signature does not match. The check is constant-time.
 */
export async function readSignedToken(secret: string, value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const dot = value.lastIndexOf('.');
  if (dot < 1) return null;
  const token = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  if (signature.length !== 44 || token.length > 128) return null;
  return (await verifyBase64Hmac(secret, token, signature)) ? token : null;
}

function isRole(value: string | null): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

/** Look a session up by its token. Expired sessions and banned people count as signed out. */
export async function findSession(env: Env, token: string, now = Date.now()): Promise<(LoadedSession & { updatedAt: number }) | null> {
  const row = await env.DB.prepare(
    `SELECT s."id" AS sid, s."token" AS token, s."expiresAt" AS expiresAt, s."createdAt" AS createdAt, s."updatedAt" AS updatedAt,
            s."impersonatedBy" AS impersonatedBy,
            u."id" AS uid, u."email" AS email, u."name" AS name, u."image" AS image, u."role" AS urole,
            u."banned" AS banned, u."banExpires" AS banExpires,
            o."id" AS oid, o."name" AS oname, o."slug" AS oslug, m."role" AS mrole
       FROM "session" s
       JOIN "user" u ON u."id" = s."userId"
       LEFT JOIN "member" m ON m."userId" = s."userId" AND m."organizationId" = s."activeOrganizationId"
       LEFT JOIN "organization" o ON o."id" = m."organizationId"
      WHERE s."token" = ?1`,
  )
    .bind(token)
    .first<SessionRow>();
  if (!row) return null;

  const expiresAt = Date.parse(row.expiresAt);
  if (!(expiresAt > now)) return null;
  if (row.banned && (!row.banExpires || Date.parse(row.banExpires) > now)) return null;

  return {
    session: { id: row.sid, createdAt: Date.parse(row.createdAt), expiresAt, impersonatedBy: row.impersonatedBy || null },
    user: { id: row.uid, email: row.email, name: row.name, image: row.image, isInstanceOwner: row.urole === 'admin' },
    org: row.oid && row.oname !== null && row.oslug !== null && isRole(row.mrole) ? { id: row.oid, name: row.oname, slug: row.oslug, role: row.mrole } : null,
    updatedAt: Date.parse(row.updatedAt),
  };
}

const loaded = new WeakMap<Request, LoadedSession | null>();

/** The session behind this request's cookie, or null. Cached per request. */
export async function sessionFromRequest(c: Context<AppEnv>): Promise<LoadedSession | null> {
  const cached = loaded.get(c.req.raw);
  if (cached !== undefined) return cached;

  const origin = baseUrl(c.env, c.req.url);
  const name = sessionCookieName(origin);
  const token = await readSignedToken(c.env.AUTH_SECRET, getCookie(c, name));
  const found = token ? await findSession(c.env, token) : null;
  if (!token || !found) {
    loaded.set(c.req.raw, null);
    return null;
  }

  const now = Date.now();
  const due = now - found.updatedAt >= SESSION_REFRESH_SEC * 1000;
  // "Sign in as" sessions are short on purpose and must run out on their own.
  if (due && !found.session.impersonatedBy) {
    const expires = new Date(now + SESSION_TTL_SEC * 1000);
    await c.env.DB.prepare('UPDATE "session" SET "expiresAt" = ?1, "updatedAt" = ?2 WHERE "id" = ?3')
      .bind(expires.toISOString(), new Date(now).toISOString(), found.session.id)
      .run();
    found.session.expiresAt = expires.getTime();
    // Same signed value, new lifetime: the browser would otherwise drop the cookie early.
    setCookie(c, name, getCookie(c, name)!, {
      path: '/',
      httpOnly: true,
      secure: secureCookies(origin),
      sameSite: 'Lax',
      maxAge: SESSION_TTL_SEC,
    });
  }

  const result: LoadedSession = { session: found.session, user: found.user, org: found.org };
  loaded.set(c.req.raw, result);
  return result;
}

/** Details of the current session (id, impersonation) for code that needs more than `c.get('user')`. */
export async function currentSession(c: Context<AppEnv>): Promise<SessionInfo | null> {
  return (await sessionFromRequest(c))?.session ?? null;
}
