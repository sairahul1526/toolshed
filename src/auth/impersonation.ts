/**
 * The parts of "sign in as" that signing out and the owner admin service share. While the owner
 * is signed in as someone else, Better Auth keeps the owner's own session token in a signed,
 * HttpOnly cookie beside the session cookie, so stopping can put the owner back.
 */
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { audit } from '../core/audit';
import type { AppEnv, Env } from '../env';
import { baseUrl, COOKIE_PREFIX, secureCookies } from './auth';
import { readSignedToken } from './session';
import { findUserById } from './users';

/** The owner's own session token from the `admin_session` cookie, or null when it is missing or forged. */
export async function ownerSessionToken(c: Context<AppEnv>): Promise<string | null> {
  const secure = secureCookies(baseUrl(c.env, c.req.url));
  const value = await readSignedToken(c.env.AUTH_SECRET, getCookie(c, `${secure ? '__Secure-' : ''}${COOKIE_PREFIX}.admin_session`));
  // Stored as `<token>:<remember flag>`.
  return value?.split(':')[0] || null;
}

/** The audit line for the end of a "sign in as" session. The owner is the actor, never the person they were. */
export async function recordImpersonationEnd(env: Env, ownerId: string, target: { id: string; email: string }, ip: string | null): Promise<void> {
  const owner = await findUserById(env, ownerId);
  await audit(env, {
    orgId: null,
    actorId: ownerId,
    actorLabel: owner?.email ?? null,
    action: 'impersonation.stopped',
    targetType: 'user',
    targetId: target.id,
    summary: `Stopped being signed in as ${target.email}`,
    ip,
  });
}
