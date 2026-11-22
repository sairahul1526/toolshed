/**
 * Route guards. They only read what `loadAuth` (src/auth) put on the request:
 * `user`, `org` and `auth`. Use them in this order: requireUser → requireSession (dashboard
 * only) → requireOrg → requireScope.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv, Role } from '../env';
import { roleAtLeast } from '../env';
import { errors, wantsJson } from './errors';

/** A signed-in person, an API key or a JWT. Browsers are sent to the sign-in page. */
export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth').kind === 'anon') {
    if (wantsJson(c) || c.req.method !== 'GET') throw errors.unauthorized();
    const url = new URL(c.req.url);
    return c.redirect(`/sign-in?next=${encodeURIComponent(url.pathname + url.search)}`);
  }
  await next();
};

/**
 * A person signed in through the browser, for the dashboard. A key or token is only as strong as
 * its scopes, and pages check roles, not scopes: a read-only key acting as an admin could post
 * any dashboard form. Keys and tokens belong on `/api/v1`. Use after `requireUser`.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth').kind !== 'session') {
    throw errors.forbidden('Keys and tokens only work on the API. Sign in to the dashboard to use these pages.');
  }
  await next();
};

/** An active workspace, and at least `minRole` in it. Viewer is the weakest role. */
export function requireOrg(minRole: Role = 'viewer'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const org = c.get('org');
    if (!org) {
      if (c.get('auth').kind === 'anon') throw errors.unauthorized();
      if (wantsJson(c) || c.req.method !== 'GET') throw errors.forbidden('Pick or create a workspace first.');
      return c.redirect('/welcome');
    }
    if (!roleAtLeast(org.role, minRole)) throw errors.forbidden(roleMessage(minRole));
    await next();
  };
}

/** Same check as `requireOrg(minRole)`, for use inside a handler: `needRole(c, 'admin')`. */
export function needRole(c: { get(key: 'org'): AppEnv['Variables']['org'] }, minRole: Role): void {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  if (!roleAtLeast(org.role, minRole)) throw errors.forbidden(roleMessage(minRole));
}

function roleMessage(minRole: Role): string {
  if (minRole === 'owner') return 'Only the workspace owner can do that.';
  if (minRole === 'admin') return 'Only workspace admins can do that. Ask an admin for access.';
  if (minRole === 'member') return 'Viewers can’t change things. Ask an admin for the Member role.';
  return 'You don’t have access to that. Ask a workspace admin.';
}

/** True when the request's scopes cover `scope`. `links:write` also covers `links:read`. */
export function hasScope(scopes: string[], scope: string): boolean {
  if (scopes.includes('*') || scopes.includes(scope)) return true;
  const [mod, verb] = scope.split(':');
  if (scopes.includes(`${mod}:*`)) return true;
  return verb === 'read' && scopes.includes(`${mod}:write`);
}

/**
 * The caller must hold `scope` (for example `links:write`). Sessions hold every scope, so for
 * people the role decides: read scopes need Viewer, every other scope needs Member.
 */
export function requireScope(scope: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const auth = c.get('auth');
    if (auth.kind === 'anon') throw errors.unauthorized();
    if (!hasScope(auth.scopes, scope)) throw errors.forbidden(`This key doesn’t have the ${scope} permission.`);
    if (!scope.endsWith(':read')) needRole(c, 'member');
    await next();
  };
}

/**
 * Refuses while an install owner is signed in as someone else. A "sign in as" session ends within
 * the hour; a key, token, signing secret or export made during it would keep working afterwards,
 * so none can be made. Pass `auth.impersonatedBy` (or the same field of a service's actor).
 */
export function refuseWhileImpersonating(impersonatedBy: string | null | undefined): void {
  if (impersonatedBy) throw errors.forbidden('You can’t do this while signed in as someone else.');
}

/** Only the person who claimed this install. */
export const requireInstanceOwner: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')?.isInstanceOwner) throw errors.forbidden('Only the owner of this install can open that.');
  await next();
};

/**
 * Blocks cross-site form posts. Cookie-signed requests that change something must come from our own
 * pages. API keys and JWTs are not sent by browsers on their own, so they skip the check.
 */
export const sameOrigin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const method = c.req.method;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
  if (c.get('auth').kind === 'apikey' || c.get('auth').kind === 'jwt') return next();
  const origin = c.req.header('origin');
  if (origin) {
    if (origin !== new URL(c.req.url).origin) throw errors.forbidden('That request came from another site, so it was blocked.');
  } else {
    const site = c.req.header('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'none') {
      throw errors.forbidden('That request came from another site, so it was blocked.');
    }
  }
  await next();
};
