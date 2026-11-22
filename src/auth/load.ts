/**
 * `loadAuth` answers "who is asking?" for every request that may need to know. It fills `user`,
 * `org` and `auth` and lets the request through: the guards in core/guards.ts decide what an
 * anonymous caller may see. It refuses two things itself: a caller over a rate limit (429), and
 * every caller while the install has no usable `AUTH_SECRET` (a setup error).
 */
import type { Context, MiddlewareHandler } from 'hono';
import { capRole, enforceApiKeyRateLimit, KEY_PREFIX, liveKeyRole, touchApiKey, verifyApiKey, weakerRole } from '../core/apikeys';
import type { KeyRole } from '../core/apikeys';
import { verifyJwt } from '../core/jwt';
import { requireSecret } from '../core/secret';
import type { ActiveOrg, AppEnv, Env, Role } from '../env';
import { ROLES } from '../env';
import { clientIp, enforceHit } from './http';
import { sessionFromRequest } from './session';
import { isBanned } from './users';

const BEARER = /^Bearer +([A-Za-z0-9._~+/=-]{1,4096})$/;

function isRole(value: string | null): value is Role {
  return !!value && (ROLES as readonly string[]).includes(value);
}

/** What a key or token says about itself, before the database is asked whether it is still true. */
interface Bearer {
  orgId: string;
  role: KeyRole;
  /** The person it stands for: a personal key's owner, or who asked for the token. */
  userId?: string | null;
  /** The key a token was made from. The key's row then says whose it is and whether it still works. */
  keyId?: string | null;
}

interface BearerRow {
  id: string;
  name: string;
  slug: string;
  kid: string | null;
  kind: string | null;
  role: string | null;
  kuser: string | null;
  revoked_at: number | null;
  expires_at: number | null;
  sa_role: string | null;
  sa_deleted_at: number | null;
  uid: string | null;
  banned: number | null;
  banExpires: string | null;
  mrole: string | null;
}

/**
 * The workspace a key or token acts in, and the role it has there right now. One query.
 *
 * A token is checked without the database, so on its own it would keep working for 15 minutes
 * whatever happened since. This is where "since" is caught:
 * - a token made from a key stops when the key is revoked, runs out, or loses its service account;
 * - anything that stands for a person stops when they are suspended, gone, or no longer a member
 *   of the workspace, and is never stronger than the role they hold today.
 * Service account keys stand for nobody, so nobody leaving stops them.
 */
async function orgFor(env: Env, bearer: Bearer, now = Date.now()): Promise<ActiveOrg | null> {
  const row = await env.DB.prepare(
    `SELECT o."id" AS id, o."name" AS name, o."slug" AS slug,
            k.id AS kid, k.kind AS kind, k.role AS role, k.user_id AS kuser, k.revoked_at AS revoked_at, k.expires_at AS expires_at,
            s.role AS sa_role, s.deleted_at AS sa_deleted_at,
            u."id" AS uid, u."banned" AS banned, u."banExpires" AS banExpires, m."role" AS mrole
       FROM "organization" o
       LEFT JOIN api_keys k ON k.id = ?3 AND k.org_id = o."id"
       LEFT JOIN service_accounts s ON s.id = k.service_account_id AND s.org_id = k.org_id
       LEFT JOIN "user" u ON u."id" = COALESCE(?2, k.user_id)
       LEFT JOIN "member" m ON m."organizationId" = o."id" AND m."userId" = u."id"
      WHERE o."id" = ?1`,
  )
    .bind(bearer.orgId, bearer.userId ?? null, bearer.keyId ?? null)
    .first<BearerRow>();
  if (!row) return null;

  let role = bearer.role;
  let person = bearer.userId ?? null;
  if (bearer.keyId) {
    const current = row.kid && row.kind && row.role ? liveKeyRole({ ...row, kind: row.kind, role: row.role }, now) : null;
    if (!current) return null;
    role = weakerRole(role, current);
    if (row.kind !== 'service') {
      // A personal key with no owner on record stands for nobody we can check.
      if (!row.kuser) return null;
      person = row.kuser;
    }
  }
  if (person) {
    if (!row.uid || isBanned(row, now) || !isRole(row.mrole)) return null;
    role = weakerRole(role, capRole(row.mrole));
  }
  return { id: row.id, name: row.name, slug: row.slug, role };
}

/**
 * A key or token in the Authorization header. One that proves nothing leaves the caller anonymous
 * and counts against their address, so nobody can work through guesses at speed.
 */
async function fromBearer(c: Context<AppEnv>, token: string): Promise<void> {
  if (token.startsWith(KEY_PREFIX)) {
    const key = await verifyApiKey(c.env, token);
    const org = key ? await orgFor(c.env, { orgId: key.orgId, role: key.role, userId: key.userId }) : null;
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
  const org = claims ? await orgFor(c.env, { orgId: claims.orgId, role: claims.role, ...(claims.kind === 'user' ? { userId: claims.sub } : { keyId: claims.sub }) }) : null;
  if (!claims || !org) return enforceHit(c.env, 'bearerPerIp', clientIp(c));
  // A token made from a key shares that key's limit, so trading a key for tokens buys no extra calls.
  if (claims.kind === 'key') await enforceApiKeyRateLimit(c.env, claims.sub);
  c.set('org', org);
  c.set('auth', { kind: 'jwt', scopes: claims.scopes, ...(claims.kind === 'user' ? { userId: claims.sub } : {}) });
}

export const loadAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  // Sessions, codes and flow cookies are all signed with the secret. Without a real one, nobody gets in.
  requireSecret(c.env);
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
        const impersonatedBy = loaded.session.impersonatedBy;
        c.set('auth', { kind: 'session', scopes: ['*'], ...(impersonatedBy ? { impersonatedBy } : {}) });
      }
    }
  }
  await next();
};
