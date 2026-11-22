/**
 * The steps every way of signing in shares: sending a code, starting the session once the person
 * has proved who they are, and signing out. Pages and routes live elsewhere; this file holds the
 * rules.
 */
import type { Context } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { audit } from '../core/audit';
import { sendEmail } from '../core/email';
import { renderEmail } from '../core/email-templates';
import { errors } from '../core/errors';
import { rateLimit } from '../core/ratelimit';
import type { AppEnv } from '../env';
import { baseUrl, COOKIE_PREFIX, getAuth, secureCookies } from './auth';
import { callAuth } from './bridge';
import { issueCode } from './codes';
import { CODE_TTL_MS, LIMITS } from './config';
import { fingerprint } from './crypto';
import { clientIp, forwardCookies, hit, setFlow } from './http';
import { hasOpenInvite } from './invites';
import { sessionCookieName, sessionFromRequest } from './session';
import { findUserByEmail, type UserRow } from './users';

export type SignInMethod = 'code' | 'link' | 'password' | 'passkey' | 'two-step' | 'recovery-code' | 'claim' | 'invite';

const METHOD_TEXT: Record<SignInMethod, string> = {
  code: 'an emailed code',
  link: 'an emailed link',
  password: 'a password',
  passkey: 'a passkey',
  'two-step': 'an authenticator code',
  'recovery-code': 'a recovery code',
  claim: 'the first-run claim',
  invite: 'an invite',
};

/**
 * Run work after the response where the platform allows it. Sending the email this way keeps the
 * reply just as fast for an address we know as for one we do not, so timing gives nothing away.
 */
export function background(c: Context<AppEnv>, work: Promise<unknown>): Promise<void> {
  const guarded = work.then(
    () => undefined,
    (err: unknown) => console.error('[auth] background work failed', err),
  );
  try {
    c.executionCtx.waitUntil(guarded);
    return Promise.resolve();
  } catch {
    // No execution context (unit tests): finish the work before answering.
    return guarded;
  }
}

/**
 * Email a sign-in code and link, and remember the code for this browser. An address with no
 * account and no open invite gets the same answer and the same page, but no email. Returns
 * seconds to wait when a limit was hit, otherwise 0.
 */
export async function startCodeSignIn(c: Context<AppEnv>, email: string, next: string): Promise<number> {
  const ip = clientIp(c);
  const who = await fingerprint(c.env.AUTH_SECRET, email);
  const wait = (await hit(c.env, 'codePerIp', ip)) || (await hit(c.env, 'codePerEmail', who));
  if (wait) return wait;

  // Both lookups always run, so the work done is the same for every address.
  const [user, invited] = await Promise.all([findUserByEmail(c.env, email), hasOpenInvite(c.env, email)]);
  const known = !!user || invited;
  const issued = await issueCode(c.env, {
    purpose: 'sign-in',
    email,
    ref: next,
    deliverable: known,
    ip,
    userAgent: c.req.header('user-agent'),
  });
  if (known) {
    const link = `${baseUrl(c.env, c.req.url)}/sign-in/link/${issued.linkToken}`;
    await background(
      c,
      renderEmail(c.env, { template: 'sign-in-code', data: { code: issued.code, minutes: CODE_TTL_MS / 60_000, link } }).then((mail) =>
        sendEmail(c.env, { to: email, template: 'sign-in-code', tag: 'auth', ...mail }),
      ),
    );
  }
  await setFlow(c, 'sign-in', { codeId: issued.id, email, next });
  return 0;
}

/** The name a new account starts with: the part of the address before the @. The invite page asks for a real one. */
export function defaultName(email: string): string {
  return email.slice(0, email.lastIndexOf('@')).replace(/[\u0000-\u001f\u007f<>]/g, '').slice(0, 80) || 'New member';
}

/**
 * The account behind an address that has just proved it owns the inbox. Accounts are by invite
 * only: an address with no account gets one here when, and only when, it has an invite it can
 * still accept. Everyone else gets null.
 */
export async function accountFor(c: Context<AppEnv>, email: string): Promise<UserRow | null> {
  const user = await findUserByEmail(c.env, email);
  if (user) return user;
  if (!(await hasOpenInvite(c.env, email))) return null;

  const auth = await getAuth(c.env, c.req.url);
  const name = defaultName(email);
  let made = false;
  try {
    made = (await callAuth(() => auth.api.createAccount({ body: { email, name, instanceOwner: false }, asResponse: true }))).ok;
  } catch (err) {
    // Two tabs finishing at the same moment: the second finds the account the first one made.
    console.error('[auth] could not create the invited account', err);
  }
  const created = await findUserByEmail(c.env, email);
  if (!created) throw errors.internal();
  if (made) {
    await audit(c.env, {
      orgId: null,
      actorId: created.id,
      actorLabel: created.email,
      action: 'user.created',
      targetType: 'user',
      targetId: created.id,
      summary: `Created an account for ${created.email} from an invite`,
      ip: clientIp(c),
    });
  }
  return created;
}

export type Finished = { state: 'done'; sessionId: string } | { state: 'two-step' } | { state: 'banned' };

/**
 * Start a session for someone who has just proved who they are. A brand-new session id is always
 * made, and the one this browser held before (if any) is ended, so a planted cookie is worthless.
 */
export async function finishSignIn(
  c: Context<AppEnv>,
  user: { id: string; email: string },
  method: SignInMethod,
  opts: { twoStep?: boolean } = {},
): Promise<Finished> {
  const auth = await getAuth(c.env, c.req.url);
  const before = await sessionFromRequest(c);
  const reply = await callAuth<{ twoStep: boolean; sessionId: string | null }>(() =>
    auth.api.issueSession({ body: { userId: user.id, twoStep: opts.twoStep ?? true }, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok) {
    if (reply.code === 'BANNED_USER') return { state: 'banned' };
    throw errors.internal();
  }
  forwardCookies(c, reply.cookies);
  if (reply.data?.twoStep || !reply.data?.sessionId) return { state: 'two-step' };

  await recordSignIn(c, user, method, before?.session.id);
  return { state: 'done', sessionId: reply.data.sessionId };
}

/** Write the audit line for a finished sign-in and end the session this browser held before. */
export async function recordSignIn(c: Context<AppEnv>, user: { id: string; email: string }, method: SignInMethod, priorSessionId?: string): Promise<void> {
  if (priorSessionId) await c.env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1').bind(priorSessionId).run();
  await audit(c.env, {
    orgId: null,
    actorId: user.id,
    actorLabel: user.email,
    action: 'user.signed_in',
    targetType: 'user',
    targetId: user.id,
    summary: `Signed in with ${METHOD_TEXT[method]}`,
    meta: { method },
    ip: clientIp(c),
  });
}

/**
 * Note a run of failed sign-ins in the audit log. One line per address per window, however many
 * guesses follow, so the log cannot be flooded.
 */
export async function recordFailedBurst(c: Context<AppEnv>, email: string, what: 'code' | 'password' | 'two-step'): Promise<void> {
  const who = await fingerprint(c.env.AUTH_SECRET, email);
  const first = await rateLimit(c.env, `auth.burst:${what}:${who}`, { limit: 1, windowSec: LIMITS.wrongPerEmail.windowSec });
  if (!first.ok) return;
  const user = await findUserByEmail(c.env, email);
  await audit(c.env, {
    orgId: null,
    actorId: user?.id ?? null,
    actorType: 'system',
    actorLabel: email,
    action: 'user.sign_in_paused',
    targetType: 'user',
    ...(user ? { targetId: user.id } : {}),
    summary: `Too many wrong ${what === 'code' ? 'codes' : what === 'password' ? 'passwords' : 'authenticator codes'} for ${email}`,
    meta: { what },
    ip: clientIp(c),
  });
}

/** End this browser's session and clear every cookie the sign-in flow may have left. */
export async function signOut(c: Context<AppEnv>): Promise<void> {
  const current = await sessionFromRequest(c);
  if (current) {
    await c.env.DB.prepare('DELETE FROM "session" WHERE "id" = ?1').bind(current.session.id).run();
    await audit(c.env, {
      orgId: null,
      actorId: current.user.id,
      actorLabel: current.user.email,
      action: 'user.signed_out',
      targetType: 'user',
      targetId: current.user.id,
      summary: 'Signed out',
      ip: clientIp(c),
    });
  }
  const origin = baseUrl(c.env, c.req.url);
  const secure = secureCookies(origin);
  deleteCookie(c, sessionCookieName(origin), { path: '/', secure });
  for (const name of ['two_factor', 'admin_session', 'dont_remember', 'session_data']) {
    deleteCookie(c, `${secure ? '__Secure-' : ''}${COOKIE_PREFIX}.${name}`, { path: '/', secure });
  }
}
