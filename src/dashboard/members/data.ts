/**
 * What the screen decides before it draws: which role names a person may hand out, and which
 * slice of the people list to show. The list comes from the member service in one query, so
 * filtering and paging happen here on at most 500 rows, with the filters kept in the query string.
 */
import type { Member } from '../../auth/service';
import type { Role } from '../../env';
import { ROLES } from '../../env';

export const BASE = '/app/members';
export const PAGE_SIZE = 50;

export type Tab = 'people' | 'invites';

export interface PeopleQuery {
  q: string;
  role: Role | '';
  after: string | null;
}

export interface PeoplePage {
  rows: Member[];
  /** People who match the filters. */
  matched: number;
  /** User id to pass as `after` for the next page, or null on the last page. */
  next: string | null;
}

/** Roles the person may give out: only an owner can make an owner. */
export function assignableRoles(actorRole: Role): Role[] {
  return actorRole === 'owner' ? [...ROLES] : ROLES.filter((r) => r !== 'owner');
}

/** May `actorRole` change or remove this person? Not themselves, and only an owner touches an owner. */
export function canManage(actorRole: Role, member: Member): boolean {
  if (member.isYou) return false;
  if (actorRole !== 'owner' && actorRole !== 'admin') return false;
  return member.role !== 'owner' || actorRole === 'owner';
}

export function readQuery(get: (name: string) => string | undefined): PeopleQuery {
  const role = get('role') ?? '';
  return {
    q: (get('q') ?? '').trim().slice(0, 100),
    role: (ROLES as readonly string[]).includes(role) ? (role as Role) : '',
    after: get('after') || null,
  };
}

export function pageOfPeople(members: Member[], query: PeopleQuery): PeoplePage {
  const needle = query.q.toLowerCase();
  const hits = members.filter((m) => (!query.role || m.role === query.role) && (!needle || m.name.toLowerCase().includes(needle) || m.email.toLowerCase().includes(needle)));
  const start = query.after ? hits.findIndex((m) => m.userId === query.after) + 1 : 0;
  const rows = hits.slice(start, start + PAGE_SIZE);
  const last = rows[rows.length - 1];
  return { rows, matched: hits.length, next: last && start + PAGE_SIZE < hits.length ? last.userId : null };
}

export function listHref(params: { tab?: Tab; q?: string; role?: string; after?: string | null }): string {
  const qs = new URLSearchParams();
  if (params.tab === 'invites') qs.set('tab', 'invites');
  if (params.q) qs.set('q', params.q);
  if (params.role) qs.set('role', params.role);
  if (params.after) qs.set('after', params.after);
  const text = qs.toString();
  return text ? `${BASE}?${text}` : BASE;
}
