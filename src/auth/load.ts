/**
 * `loadAuth` answers "who is asking?" for every request that may need to know. It fills `user`,
 * `org` and `auth` and always lets the request through: the guards in core/guards.ts decide what
 * an anonymous caller may see.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { KEY_PREFIX, verifyApiKey } from '../core/apikeys';
import { verifyJwt } from '../core/jwt';
import type { ActiveOrg, AppEnv, Env, Role } from '../env';
import { sessionFromRequest } from './session';

const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]{1,4096})$/;

async function orgFor(env: Env, orgId: string, role: Role): Promise<ActiveOrg | null> {
  const row = await env.DB.prepare('SELECT "id", "name", "slug" FROM "organization" WHERE "id" = ?1')
    .bind(orgId)
    .first<{ id: string; name: string; slug: string }>();
  return row ? { id: row.id, name: row.name, slug: row.slug, role } : null;
}

/** A key or token in the Authorization header. A header that proves nothing leaves the caller anonymous. */
async function fromBearer(c: Context<AppEnv>, token: string): Promise<void> {
  if (token.startsWith(KEY_PREFIX)) {
    const key = await verifyApiKey(c.env, token);
    const org = key ? await orgFor(c.env, key.orgId, key.role) : null;
    if (!key || !org) return;
    c.set('org', org);
    c.set('auth', { kind: 'apikey', scopes: key.scopes, keyId: key.keyId });
    return;
  }
  const claims = await verifyJwt(c.env, token);
  const org = claims ? await orgFor(c.env, claims.orgId, claims.role) : null;
  if (!claims || !org) return;
  c.set('org', org);
  c.set('auth', { kind: 'jwt', scopes: claims.scopes });
}

export const loadAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Mounted on overlapping paths; the first run has already answered.
  if (c.get('auth').kind === 'anon') {
    const header = c.req.header('authorization');
    if (header !== undefined) {
      // An explicit credential is never mixed with a cookie: a bad one means "anonymous".
      const token = BEARER.exec(header)?.[1];
      if (token) await fromBearer(c, token);
    } else {
      const loaded = await sessionFromRequest(c);
      if (loaded) {
        c.set('user', loaded.user);
        c.set('org', loaded.org);
        c.set('auth', { kind: 'session', scopes: ['*'] });
      }
    }
  }
  await next();
};
