/**
 * `loadAuth` answers "who is asking?" for every request that may need to know. It fills `user`,
 * `org` and `auth` and lets the request through: the guards in core/guards.ts decide what an
 * anonymous caller may see. The one thing it refuses is a caller over a rate limit (429).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { enforceApiKeyRateLimit, KEY_PREFIX, touchApiKey, verifyApiKey } from '../core/apikeys';
import { verifyJwt } from '../core/jwt';
import type { ActiveOrg, AppEnv, Env, Role } from '../env';
import { clientIp, enforceHit } from './http';
import { sessionFromRequest } from './session';
import { isBanned } from './users';

const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]{1,4096})$/;

/**
 * The workspace a key or token acts in. One that stands for a person (`userId`) stops counting
 * when that person is suspended or their account is gone. One query either way.
 */
async function orgFor(env: Env, orgId: string, role: Role, userId?: string | null): Promise<ActiveOrg | null> {
  const row = await env.DB.prepare(
    `SELECT o."id" AS id, o."name" AS name, o."slug" AS slug, u."id" AS uid, u."banned" AS banned, u."banExpires" AS banExpires
       FROM "organization" o LEFT JOIN "user" u ON u."id" = ?2 WHERE o."id" = ?1`,
  )
    .bind(orgId, userId ?? null)
    .first<{ id: string; name: string; slug: string; uid: string | null; banned: number | null; banExpires: string | null }>();
  if (!row) return null;
  if (userId && (!row.uid || isBanned(row))) return null;
  return { id: row.id, name: row.name, slug: row.slug, role };
}

/**
 * A key or token in the Authorization header. One that proves nothing leaves the caller anonymous
 * and counts against their address, so nobody can work through guesses at speed.
 */
async function fromBearer(c: Context<AppEnv>, token: string): Promise<void> {
  if (token.startsWith(KEY_PREFIX)) {
    const key = await verifyApiKey(c.env, token);
    const org = key ? await orgFor(c.env, key.orgId, key.role, key.userId) : null;
    if (!key || !org) return enforceHit(c.env, 'bearerPerIp', clientIp(c));
    await enforceApiKeyRateLimit(c.env, key.keyId);
    const touched = touchApiKey(c.env, key, { ip: clientIp(c) }).catch((err: unknown) => console.error('[auth] could not record key use', err));
    try {
      // "Last used" is written after the answer is on its way.
      c.executionCtx.waitUntil(touched);
    } catch {
      // No execution context (unit tests): finish the write before answering.
      await touched;
    }
    c.set('org', org);
    c.set('auth', { kind: 'apikey', scopes: key.scopes, keyId: key.keyId, ...(key.userId ? { userId: key.userId } : {}) });
    return;
  }
  // A token only counts on the address it was made for.
  const claims = await verifyJwt(c.env, token, { issuer: new URL(c.req.url).origin });
  const org = claims ? await orgFor(c.env, claims.orgId, claims.role, claims.kind === 'user' ? claims.sub : null) : null;
  if (!claims || !org) return enforceHit(c.env, 'bearerPerIp', clientIp(c));
  // A token made from a key shares that key's limit, so trading a key for tokens buys no extra calls.
  if (claims.kind === 'key') await enforceApiKeyRateLimit(c.env, claims.sub);
  c.set('org', org);
  c.set('auth', { kind: 'jwt', scopes: claims.scopes, ...(claims.kind === 'user' ? { userId: claims.sub } : {}) });
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
