/**
 * Who is acting. Every service function gets the person from the session cookie, never from a
 * value its caller made up, and looks their role up in the database again before changing
 * anything.
 */
import type { Context } from 'hono';
import { audit, type AuditEntry } from '../../core/audit';
import { errors } from '../../core/errors';
import type { AppEnv, Env, Role } from '../../env';
import { roleAtLeast } from '../../env';
import { FRESH_SIGN_IN_SEC } from '../config';
import { authErrors } from '../errors';
import { clientIp } from '../http';
import { sessionFromRequest } from '../session';

export interface Actor {
  id: string;
  email: string;
  name: string;
  /** For the audit log. */
  ip?: string | null;
  /** The instance owner's id when this is a "sign in as" session. */
  impersonatedBy?: string | null;
}

export interface SignedIn extends Actor {
  sessionId: string;
  /** When this session began, ms. */
  signedInAt: number;
  ip: string;
  impersonatedBy: string | null;
}

/**
 * The signed-in person behind a request. API keys and tokens are not people: they cannot manage
 * members, accounts or workspaces.
 */
export async function actorFrom(c: Context<AppEnv>): Promise<SignedIn> {
  const loaded = c.get('auth').kind === 'session' ? await sessionFromRequest(c) : null;
  if (!loaded) throw errors.unauthorized();
  return {
    id: loaded.user.id,
    email: loaded.user.email,
    name: loaded.user.name,
    ip: clientIp(c),
    sessionId: loaded.session.id,
    signedInAt: loaded.session.createdAt,
    impersonatedBy: loaded.session.impersonatedBy,
  };
}

/** The person themselves, not the owner signed in as them. For anything that changes an account. */
export async function selfFrom(c: Context<AppEnv>): Promise<SignedIn> {
  const actor = await actorFrom(c);
  if (actor.impersonatedBy) throw authErrors.impersonating();
  return actor;
}

/**
 * The person themselves, signed in a short while ago. Changing a password, an email, passkeys or
 * two-step sign-in asks for this, so a browser left open (or a stolen cookie) cannot be used to
 * take the account over for good.
 */
export async function freshFrom(c: Context<AppEnv>, now = Date.now()): Promise<SignedIn> {
  const actor = await selfFrom(c);
  if (now - actor.signedInAt > FRESH_SIGN_IN_SEC * 1000) throw authErrors.sign_in_again();
  return actor;
}

export interface WorkspaceActor extends SignedIn {
  orgId: string;
  orgName: string;
  orgSlug: string;
  /** The person's role in the active workspace, as the database has it for this request. */
  role: Role;
}

/**
 * The signed-in person together with their active workspace and their role in it. Throws when
 * they have no active workspace or their role is below `min`.
 */
export async function workspaceActor(c: Context<AppEnv>, min: Role = 'viewer'): Promise<WorkspaceActor> {
  const actor = await actorFrom(c);
  const org = (await sessionFromRequest(c))?.org;
  if (!org) throw authErrors.workspace_not_found();
  if (!roleAtLeast(org.role, min)) throw authErrors.role_needed();
  return { ...actor, orgId: org.id, orgName: org.name, orgSlug: org.slug, role: org.role };
}

/** True when this person owns the install. Read from the database every time. */
export async function isInstanceOwner(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(`SELECT 1 AS yes FROM "user" WHERE "id" = ?1 AND "role" = 'admin'`).bind(userId).first<{ yes: number }>();
  return !!row;
}

/** Write an audit line for something `actor` did. A "sign in as" session is always marked. */
export function auditBy(env: Env, actor: Actor, entry: Omit<AuditEntry, 'actorId' | 'actorLabel' | 'actorType' | 'ip'>): Promise<void> {
  return audit(env, {
    ...entry,
    actorId: actor.id,
    actorLabel: actor.email,
    ip: actor.ip ?? null,
    ...(actor.impersonatedBy ? { meta: { ...entry.meta, impersonatedBy: actor.impersonatedBy } } : {}),
  });
}
