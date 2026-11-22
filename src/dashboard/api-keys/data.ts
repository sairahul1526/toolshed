/**
 * What the screen needs from the request and from the key services. Nothing here touches a
 * table: every read and write goes through `core/apikeys` and `core/jwt`.
 */
import type { Context } from 'hono';
import { keyErrors } from '../../core/apikeys';
import type { ApiKey, KeyActor } from '../../core/apikeys';
import { errors } from '../../core/errors';
import type { AppEnv } from '../../env';

export const PAGE_SIZE = 50;
/** `listApiKeys` returns this many at most, newest first. Said on the page when it is hit. */
export const KEY_LIST_CAP = 500;

/**
 * Who is asking. The screen is for signed-in people only: an API key or a token that somehow
 * reached it is refused here, and again by every service call (`via: 'session'`).
 */
export function sessionActor(c: Context<AppEnv>): KeyActor {
  const org = c.get('org');
  const user = c.get('user');
  if (c.get('auth').kind !== 'session') throw keyErrors.session_required();
  if (!org || !user) throw errors.unauthorized();
  return {
    orgId: org.id,
    userId: user.id,
    role: org.role,
    label: user.name || user.email,
    ip: c.req.header('cf-connecting-ip') ?? null,
    via: 'session',
    impersonatedBy: c.get('auth').impersonatedBy ?? null,
  };
}

export interface KeyPage {
  keys: ApiKey[];
  total: number;
  /** Id to pass as `after` for the next page, or null on the last page. */
  next: string | null;
  /** The list hit the service's limit, so older keys are not shown at all. */
  capped: boolean;
}

/**
 * One page of a list the service already returned, newest first. The cursor is a key id, so
 * a key made or revoked while someone pages never shifts a row onto the wrong page. An id that
 * is no longer in the list starts again from the top.
 */
export function pageOfKeys(all: ApiKey[], after: string | null): KeyPage {
  const at = after ? all.findIndex((k) => k.id === after) : -1;
  const start = at + 1;
  const keys = all.slice(start, start + PAGE_SIZE);
  const last = keys[keys.length - 1];
  return { keys, total: all.length, next: last && start + keys.length < all.length ? last.id : null, capped: all.length >= KEY_LIST_CAP };
}

/** The search part of a link on this screen, leaving out anything that is at its default. */
export function listHref(params: { tab?: string; revoked?: boolean; after?: string | null }): string {
  const q = new URLSearchParams();
  if (params.tab === 'accounts') q.set('tab', 'accounts');
  if (params.revoked) q.set('revoked', '1');
  if (params.after) q.set('after', params.after);
  const text = q.toString();
  return text ? `/app/api-keys?${text}` : '/app/api-keys';
}
