/**
 * Types, error codes and permission checks shared by API keys and service accounts.
 */
import { z } from 'zod';
import type { Env, Role } from '../../env';
import { roleAtLeast } from '../../env';
import { audit } from '../audit';
import { defineErrors, errors } from '../errors';
import { refuseWhileImpersonating } from '../guards';

/** Roles a key or token may act with. Never `owner`: owner-only actions need a signed-in person. */
export const KEY_ROLES = ['admin', 'member', 'viewer'] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

/** Who is asking. Routes and screens build this from the request (`user`, `org`, `auth`). */
export interface KeyActor {
  orgId: string;
  userId: string;
  role: Role;
  /** Name or email. Stored as "Made by" and written to the audit log. */
  label?: string | null;
  ip?: string | null;
  /** How the request signed in. Only a session may create or change keys. Always set it: there is no default. */
  via: 'session' | 'apikey' | 'jwt';
  /** The install owner's id on a "sign in as" session (`auth.impersonatedBy`). Always pass it on from the request. */
  impersonatedBy?: string | null;
}

export const keyErrors = defineErrors('keys', {
  session_required: { status: 403, message: 'Keys and tokens can’t create or change keys. Sign in to the dashboard to do that.' },
  role_too_high: { status: 403, message: 'A key can’t have a stronger role than yours. Pick a lower role.' },
  unknown_scope: { status: 422, message: 'One of those permissions doesn’t exist. Check the list and try again.' },
  revoked: { status: 409, message: 'That key is revoked and can’t be changed. Make a new one.' },
  expired: { status: 409, message: 'That key has expired. Make a new one.' },
  already_rotated: { status: 409, message: 'That key was already replaced. Rotate the new key instead.' },
  too_many: { status: 409, message: 'This workspace has reached its limit of keys. Revoke one you no longer use, then try again.' },
  service_account_not_found: { status: 404, message: 'There is no service account with that id. It may have been deleted.' },
  name_taken: { status: 409, message: 'A service account with that name already exists. Pick another name.' },
});

export const nameSchema = z
  .string('Give it a name.')
  .trim()
  .min(1, 'Give it a name.')
  .max(80, 'Keep the name under 80 characters.')
  // Control characters would break log lines and table rows.
  .regex(/^[^\u0000-\u001f\u007f]*$/, 'Remove line breaks and other hidden characters from the name.');

export const roleSchema = z.enum(KEY_ROLES, 'Pick Admin, Member or Viewer. A key can’t act as the owner.');

/** The strongest role a key made by someone with `role` may have. */
export function capRole(role: Role): KeyRole {
  return role === 'owner' ? 'admin' : role;
}

export function weakerRole(a: KeyRole, b: KeyRole): KeyRole {
  return roleAtLeast(a, b) ? b : a;
}

export function asKeyRole(value: unknown): KeyRole | null {
  return KEY_ROLES.includes(value as KeyRole) ? (value as KeyRole) : null;
}

export function isAdmin(actor: KeyActor): boolean {
  return roleAtLeast(actor.role, 'admin');
}

/** A key that could make keys could outlive its own revocation, so only a signed-in person may. */
export function requireSession(actor: KeyActor): void {
  if (actor.via !== 'session') throw keyErrors.session_required();
}

/**
 * For making a key, replacing one, or making a service account to hang keys on. On top of
 * `requireSession`, an install owner signed in as someone else may not: what they made would keep
 * working after their hour as that person ends.
 */
export function requireOwnSession(actor: KeyActor): void {
  requireSession(actor);
  refuseWhileImpersonating(actor.impersonatedBy);
}

export function requireAdmin(actor: KeyActor, message: string): void {
  if (!isAdmin(actor)) throw errors.forbidden(message);
}

export function roleName(role: KeyRole): string {
  return role === 'admin' ? 'Admin' : role === 'member' ? 'Member' : 'Viewer';
}

export interface KeyAudit {
  action: string;
  targetType: 'api_key' | 'service_account';
  targetId: string;
  summary: string;
  meta?: Record<string, unknown>;
}

/** A line written on a "sign in as" session always says so in `meta.impersonatedBy`. */
export function auditKeys(env: Env, actor: KeyActor, entry: KeyAudit): Promise<void> {
  return audit(env, {
    orgId: actor.orgId,
    actorId: actor.userId,
    actorType: 'user',
    actorLabel: actor.label ?? null,
    ip: actor.ip ?? null,
    ...entry,
    ...(actor.impersonatedBy ? { meta: { ...entry.meta, impersonatedBy: actor.impersonatedBy } } : {}),
  });
}

/** D1 reports a broken unique index with this text. */
export function isUniqueError(err: unknown, column: string): boolean {
  return err instanceof Error && err.message.includes('UNIQUE constraint failed') && err.message.includes(column);
}
