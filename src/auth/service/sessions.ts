/**
 * The places a person is signed in. They can see each one, sign one out, or sign out everywhere
 * but here. Only ever their own: there is no session id that reaches someone else's.
 */
import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { describeDevice } from '../device';
import { authErrors } from '../errors';
import { actorFrom, auditBy, selfFrom } from './actor';

export interface SessionView {
  id: string;
  /** "Chrome on macOS". */
  device: string;
  browser: string | null;
  os: string | null;
  kind: 'phone' | 'laptop';
  ip: string | null;
  /** When it signed in, ms. */
  signedInAt: number;
  /** Last use, ms. Written at most once an hour, so "active now" means within the hour. */
  lastSeenAt: number;
  expiresAt: number;
  /** The session asking. */
  current: boolean;
  /** True when this is the owner of the install signed in as the person. */
  impersonated: boolean;
}

interface Row {
  id: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
}

/** Everywhere the asking person is signed in, this device first, then the most recently used. One query. */
export async function listSessions(c: Context<AppEnv>, now = Date.now()): Promise<SessionView[]> {
  const actor = await actorFrom(c);
  const { results } = await c.env.DB.prepare(
    `SELECT "id", "createdAt", "updatedAt", "expiresAt", "ipAddress", "userAgent", "impersonatedBy"
       FROM "session" WHERE "userId" = ?1 AND "expiresAt" > ?2 ORDER BY "updatedAt" DESC, "id" LIMIT 100`,
  )
    .bind(actor.id, new Date(now).toISOString())
    .all<Row>();
  const views = results.map((row): SessionView => {
    const device = describeDevice(row.userAgent);
    return {
      id: row.id,
      device: device.label,
      browser: device.browser,
      os: device.os,
      kind: device.kind,
      ip: row.ipAddress || null,
      signedInAt: Date.parse(row.createdAt),
      lastSeenAt: Date.parse(row.updatedAt),
      expiresAt: Date.parse(row.expiresAt),
      current: row.id === actor.sessionId,
      impersonated: !!row.impersonatedBy,
    };
  });
  return views.sort((a, b) => Number(b.current) - Number(a.current));
}

/**
 * Sign one device out. `current` is true when it was the one asking: the caller should then send
 * the person to the sign-in page, because their cookie no longer works.
 */
export async function revokeSession(c: Context<AppEnv>, sessionId: string): Promise<{ current: boolean }> {
  const actor = await selfFrom(c);
  const id = typeof sessionId === 'string' ? sessionId : '';
  // The user id is part of the statement: an id that belongs to someone else matches nothing.
  const gone = await c.env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1 AND "userId" = ?2 RETURNING "userAgent"').bind(id, actor.id).first<{ userAgent: string | null }>();
  if (!gone) throw authErrors.session_not_found();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'session.revoked',
    targetType: 'user',
    targetId: actor.id,
    summary: `Signed out ${describeDevice(gone.userAgent).label}`,
    meta: { sessionId: id },
  });
  return { current: id === actor.sessionId };
}

/** Sign out everywhere except this device. Returns how many were signed out. */
export async function revokeOtherSessions(c: Context<AppEnv>): Promise<{ count: number }> {
  const actor = await selfFrom(c);
  const done = await c.env.DB.prepare('DELETE FROM "session" WHERE "userId" = ?1 AND "id" <> ?2').bind(actor.id, actor.sessionId).run();
  const count = done.meta.changes ?? 0;
  if (count > 0) {
    await auditBy(c.env, actor, {
      orgId: null,
      action: 'session.revoked_others',
      targetType: 'user',
      targetId: actor.id,
      summary: `Signed out ${count} other ${count === 1 ? 'device' : 'devices'}`,
      meta: { count },
    });
  }
  return { count };
}
