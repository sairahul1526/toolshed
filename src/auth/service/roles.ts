/**
 * The role rules, in one place and free of database calls so each can be tested on its own:
 *
 * - Owners and admins manage members. Members and viewers do not.
 * - Only an owner can add, change or remove an owner.
 * - Nobody changes their own role, so nobody can raise it.
 */
import type { Role } from '../../env';
import { ROLES, roleAtLeast } from '../../env';
import { authErrors } from '../errors';

export const ROLE_NAMES: Record<Role, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };

/** One line on what each role may do, for invite and member screens. */
export const ROLE_HELP: Record<Role, string> = {
  owner: 'Owners can do everything, including deleting the workspace.',
  admin: 'Admins manage people, settings and every tool.',
  member: 'Members use the tools and change what is in them.',
  viewer: 'Viewers can look, but not change anything.',
};

export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** A role name from a form or a request body. */
export function parseRole(value: unknown): Role {
  const role = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!isRole(role)) throw authErrors.role_unknown();
  return role;
}

/** True when moving from `from` to `to` takes rights away. */
export function isLowered(from: Role, to: Role): boolean {
  return ROLES.indexOf(to) > ROLES.indexOf(from);
}

/**
 * May someone with `actorRole` give `next` to a person who now holds `current`? `current` is null
 * for an invite, and `next` is null when the person is being removed.
 */
export function assertMayAssign(actorRole: Role, current: Role | null, next: Role | null): void {
  if (!roleAtLeast(actorRole, 'admin')) throw authErrors.role_needed();
  if ((current === 'owner' || next === 'owner') && actorRole !== 'owner') throw authErrors.role_over_owner();
}
