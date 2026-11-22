/**
 * Sign-in pages and their form posts. Every post is checked for same-site origin, rate limited,
 * and answers with a redirect on success (so a refresh never re-sends a form).
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { z } from 'zod';
import { AppError, parse } from '../../core/errors';
import { sameOrigin } from '../../core/guards';
import type { AppEnv } from '../../env';
import { formatDate, renderAuthPage, setFlash, timeAgo } from '../../ui';
import { getAuth } from '../auth';
import { callAuth } from '../bridge';
import { inspectLink, redeemCode, redeemLink } from '../codes';
import { LIMITS, TRUST_DEVICE_SEC } from '../config';
import { fingerprint } from '../crypto';
import { describeDevice } from '../device';
import { authErrors } from '../errors';
import { clearFlow, clientIp, forwardCookies, hit, keepAddressPrivate, readFlow, setFlow, waitText } from '../http';
import { safeNext } from '../next';
import {
  CodeStep,
  DeadLink,
  EmailStep,
  InviteOnly,
  LimitedStep,
  LinkStep,
  PasswordStep,
  RecoveryStep,
  signInFooter,
  TwoStepStep,
  type LimitedReason,
} from '../pages/sign-in';
import { sessionFromRequest } from '../session';
import { accountFor, finishSignIn, recordFailedBurst, recordSignIn, signOut, startCodeSignIn, type Finished, type SignInMethod } from '../signin';
import { emailSchema, instanceClaimed } from '../users';

type C = Context<AppEnv>;

export const signInRoutes = new Hono<AppEnv>();

signInRoutes.use('/sign-in', sameOrigin);
signInRoutes.use('/sign-in/*', sameOrigin);
signInRoutes.use('/sign-out', sameOrigin);
signInRoutes.use('/api/auth/sign-out', sameOrigin);

const page = (c: C, title: string, body: Parameters<typeof renderAuthPage>[2], status?: 400 | 422 | 429) =>
  renderAuthPage(c, { title, footer: signInFooter, ...(status ? { status } : {}) }, body);

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isReason = (value: string | undefined): value is LimitedReason => value === 'codes' || value === 'requests' || value === 'password' || value === 'two-step';

/** Send the browser to the "Too many tries" page, which remembers how long is left. */
export async function limited(c: C, input: { email?: string; wait: number; reason: LimitedReason; next?: string }): Promise<Response> {
  const until = Date.now() + input.wait * 1000;
  await setFlow(c, 'limited', { ...(input.email ? { email: input.email } : {}), next: input.next ?? '/app', ref: `${input.reason}:${until}` }, Math.max(60, input.wait));
  return c.redirect('/sign-in/limited', 303);
}

/** Where to go once a sign-in step has finished, or the page to show when it could not. */
async function after(c: C, state: Finished['state'], email: string, next: string): Promise<Response> {
  if (state === 'banned') return page(c, 'Sign in', <EmailStep next={next} email={email} blocked={authErrors.banned().message} />, 400);
  clearFlow(c, 'sign-in');
  clearFlow(c, 'password');
  if (state === 'two-step') {
    await setFlow(c, 'two-step', { email, next });
    return c.redirect('/sign-in/two-step', 303);
  }
  return c.redirect(next, 303);
}

/* ---- Email ---- */

signInRoutes.get('/sign-in', async (c) => {
  const next = safeNext(c.req.query('next'));
  const user = c.get('user');
  // `again=1` is how a signed-in person proves it is still them before a sensitive change.
  const again = c.req.query('again') === '1';
  if (user && !again) return c.redirect(next);
  if (!(await instanceClaimed(c.env))) return c.redirect('/setup');
  return page(c, 'Sign in', <EmailStep next={next} {...(user ? { email: user.email, again: true } : {})} />);
});

signInRoutes.post('/sign-in', async (c) => {
  const form = await c.req.parseBody();
  const next = safeNext(form.next);
  const intent = form.intent === 'password' ? 'password' : 'code';
  const typed = text(form.email).trim();

  if (intent === 'password' && !typed) {
    await setFlow(c, 'password', { next });
    return c.redirect('/sign-in/password', 303);
  }
  const email = emailSchema.safeParse(typed);
  if (!email.success) {
    return page(c, 'Sign in', <EmailStep next={next} email={typed.slice(0, 254)} error={typed ? 'Enter an email address like name@example.com.' : 'Enter your email.'} />, 422);
  }
  if (intent === 'password') {
    await setFlow(c, 'password', { email: email.data, next });
    return c.redirect('/sign-in/password', 303);
  }
  const wait = await startCodeSignIn(c, email.data, next);
  if (wait) return limited(c, { email: email.data, wait, reason: 'requests', next });
  return c.redirect('/sign-in/code', 303);
});

/* ---- Emailed code ---- */

signInRoutes.get('/sign-in/code', async (c) => {
  const flow = await readFlow(c, 'sign-in');
  if (!flow?.codeId || !flow.email) return c.redirect('/sign-in');
  return page(c, 'Check your email', <CodeStep email={flow.email} />);
});

signInRoutes.post('/sign-in/code', async (c) => {
  const flow = await readFlow(c, 'sign-in');
  if (!flow?.codeId || !flow.email) return c.redirect('/sign-in', 303);
  const next = safeNext(flow.next);
  const wait = await hit(c.env, 'checkPerIp', clientIp(c));
  if (wait) return limited(c, { email: flow.email, wait, reason: 'codes', next });

  const form = await c.req.parseBody();
  const result = await redeemCode(c.env, { id: flow.codeId, purpose: 'sign-in', code: text(form.code) });
  if (!result.ok) {
    if (result.reason === 'limited') {
      await recordFailedBurst(c, flow.email, 'code');
      return limited(c, { email: flow.email, wait: result.retryAfter || LIMITS.wrongPerEmail.windowSec, reason: 'codes', next });
    }
    if (result.reason === 'wrong') {
      const left = `${result.triesLeft} ${result.triesLeft === 1 ? 'try' : 'tries'} left.`;
      return page(c, 'Check your email', <CodeStep email={flow.email} error={`That code isn’t right. ${left}`} />, 400);
    }
    const message = result.reason === 'used' ? authErrors.code_used().message : authErrors.code_expired().message;
    return page(c, 'Check your email', <CodeStep email={flow.email} error={message} dead />, 400);
  }
  const user = await accountFor(c, result.email);
  // A code only matches for an address that had an account or an invite when it was sent. The invite may have been cancelled since.
  if (!user) return page(c, 'Check your email', <CodeStep email={flow.email} error={authErrors.code_expired().message} dead />, 400);
  return after(c, (await finishSignIn(c, user, 'code')).state, user.email, next);
});

signInRoutes.post('/sign-in/code/resend', async (c) => {
  const flow = await readFlow(c, 'sign-in');
  if (!flow?.email) return c.redirect('/sign-in', 303);
  const next = safeNext(flow.next);
  const wait = await startCodeSignIn(c, flow.email, next);
  if (wait) return limited(c, { email: flow.email, wait, reason: 'requests', next });
  setFlash(c, { kind: 'ok', message: 'We sent a new code.' });
  return c.redirect('/sign-in/code', 303);
});

/* ---- The link in the same email ---- */

signInRoutes.get('/sign-in/link/:token', async (c) => {
  // Opening the link changes nothing: mail scanners and link previews fetch it too.
  keepAddressPrivate(c);
  const token = c.req.param('token');
  const info = await inspectLink(c.env, token);
  if (info.state !== 'ok' || info.purpose !== 'sign-in' || !info.email) {
    return page(c, 'Sign in', <DeadLink state={info.state === 'ok' ? 'invalid' : info.state} />, 400);
  }
  const now = Date.now();
  return page(
    c,
    'Finish signing in',
    <LinkStep
      token={token}
      email={info.email}
      device={describeDevice(info.userAgent).label}
      ip={info.ip ?? null}
      when={timeAgo(info.createdAt ?? now, now)}
      minutesLeft={Math.max(1, Math.ceil(((info.expiresAt ?? now) - now) / 60_000))}
    />,
  );
});

signInRoutes.post('/sign-in/link/:token', async (c) => {
  keepAddressPrivate(c);
  const wait = await hit(c.env, 'checkPerIp', clientIp(c));
  if (wait) return limited(c, { wait, reason: 'codes' });
  const result = await redeemLink(c.env, c.req.param('token'), 'sign-in');
  if (!result.ok) return page(c, 'Sign in', <DeadLink state={result.reason === 'used' ? 'used' : 'expired'} />, 400);
  const user = await accountFor(c, result.email);
  if (!user) return page(c, 'Sign in', <DeadLink state="expired" />, 400);
  return after(c, (await finishSignIn(c, user, 'link')).state, user.email, safeNext(result.ref));
});

/* ---- Password ---- */

const passwordForm = z.object({
  identifier: z.string().trim().toLowerCase().min(1, 'Enter your email or username.').max(254),
  password: z.string().min(1, 'Enter your password.').max(1024),
});

signInRoutes.get('/sign-in/password', async (c) => {
  const flow = await readFlow(c, 'password');
  if (c.get('user') && !flow) return c.redirect('/app');
  return page(c, 'Enter your password', <PasswordStep {...(flow?.email ? { email: flow.email } : {})} />);
});

signInRoutes.post('/sign-in/password', async (c) => {
  const flow = await readFlow(c, 'password');
  const next = safeNext(flow?.next);
  const form = await c.req.parseBody();
  const shown = { ...(flow?.email ? { email: flow.email } : { identifier: text(form.identifier).slice(0, 254) }) };
  let input: z.infer<typeof passwordForm>;
  try {
    input = parse(passwordForm, { identifier: flow?.email ?? text(form.identifier), password: text(form.password) });
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    return page(c, 'Enter your password', <PasswordStep {...shown} error={err.fields?.identifier ?? err.fields?.password ?? err.message} />, 422);
  }

  const who = input.identifier;
  const wait = (await hit(c.env, 'checkPerIp', clientIp(c))) || (await hit(c.env, 'passwordPerAccount', await fingerprint(c.env.AUTH_SECRET, who)));
  if (wait) {
    await recordFailedBurst(c, who, 'password');
    return limited(c, { email: who, wait, reason: 'password', next });
  }

  const auth = await getAuth(c.env, c.req.url);
  const before = await sessionFromRequest(c);
  const headers = c.req.raw.headers;
  const reply = await callAuth<{ twoFactorRedirect?: boolean; user?: { id: string; email: string } }>(() =>
    who.includes('@')
      ? auth.api.signInEmail({ body: { email: who, password: input.password }, headers, asResponse: true })
      : auth.api.signInUsername({ body: { username: who, password: input.password }, headers, asResponse: true }),
  );
  if (!reply.ok) {
    if (reply.code === 'BANNED_USER') return page(c, 'Sign in', <EmailStep next={next} blocked={authErrors.banned().message} />, 400);
    // One message for a wrong password, an unknown account and an account with no password.
    return page(c, 'Enter your password', <PasswordStep {...shown} error={authErrors.credentials_wrong().message} />, 400);
  }
  forwardCookies(c, reply.cookies);
  if (reply.data?.twoFactorRedirect || !reply.data?.user) return after(c, 'two-step', who, next);
  await recordSignIn(c, reply.data.user, 'password', before?.session.id);
  return after(c, 'done', who, next);
});

signInRoutes.post('/sign-in/password/code', async (c) => {
  const flow = await readFlow(c, 'password');
  if (!flow?.email) return c.redirect('/sign-in', 303);
  const next = safeNext(flow.next);
  const wait = await startCodeSignIn(c, flow.email, next);
  if (wait) return limited(c, { email: flow.email, wait, reason: 'requests', next });
  return c.redirect('/sign-in/code', 303);
});

/* ---- Two-step ---- */

const trustUntil = () => formatDate(Date.now() + TRUST_DEVICE_SEC * 1000);

signInRoutes.get('/sign-in/two-step', async (c) => {
  if (!(await readFlow(c, 'two-step'))) return c.redirect('/sign-in');
  return page(c, 'Two-step check', <TwoStepStep trustUntil={trustUntil()} />);
});

signInRoutes.get('/sign-in/recovery', async (c) => {
  if (!(await readFlow(c, 'two-step'))) return c.redirect('/sign-in');
  return page(c, 'Use a recovery code', <RecoveryStep />);
});

async function secondStep(c: C, method: Extract<SignInMethod, 'two-step' | 'recovery-code'>): Promise<Response> {
  const flow = await readFlow(c, 'two-step');
  if (!flow?.email) return c.redirect('/sign-in', 303);
  const next = safeNext(flow.next);
  const wait = await hit(c.env, 'checkPerIp', clientIp(c));
  if (wait) return limited(c, { email: flow.email, wait, reason: 'two-step', next });

  const form = await c.req.parseBody();
  const code = text(form.code).replace(/\s/g, '').slice(0, 64);
  const auth = await getAuth(c.env, c.req.url);
  const headers = c.req.raw.headers;
  const reply = await callAuth<{ user?: { id: string; email: string } }>(() =>
    method === 'two-step'
      ? auth.api.verifyTOTP({ body: { code, trustDevice: form.trust === 'yes' }, headers, asResponse: true })
      : auth.api.verifyBackupCode({ body: { code, trustDevice: false }, headers, asResponse: true }),
  );
  forwardCookies(c, reply.cookies);

  if (reply.ok && reply.data?.user) {
    clearFlow(c, 'two-step');
    await recordSignIn(c, reply.data.user, method);
    return c.redirect(next, 303);
  }
  if (reply.code === 'INVALID_CODE' || reply.code === 'INVALID_BACKUP_CODE') {
    return method === 'two-step'
      ? page(c, 'Two-step check', <TwoStepStep trustUntil={trustUntil()} error={authErrors.two_step_wrong().message} />, 400)
      : page(c, 'Use a recovery code', <RecoveryStep error="That recovery code isn’t right, or it was already used." />, 400);
  }
  if (reply.code === 'BANNED_USER') return page(c, 'Sign in', <EmailStep next={next} blocked={authErrors.banned().message} />, 400);
  clearFlow(c, 'two-step');
  if (reply.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE' || reply.code === 'ACCOUNT_TEMPORARILY_LOCKED') {
    await recordFailedBurst(c, flow.email, 'two-step');
    return limited(c, { email: flow.email, wait: LIMITS.wrongPerEmail.windowSec, reason: 'two-step', next });
  }
  setFlash(c, { kind: 'error', message: authErrors.two_step_expired().message });
  return c.redirect('/sign-in', 303);
}

signInRoutes.post('/sign-in/two-step', (c) => secondStep(c, 'two-step'));
signInRoutes.post('/sign-in/recovery', (c) => secondStep(c, 'recovery-code'));

/* ---- Paused, sign-up, sign out ---- */

signInRoutes.get('/sign-in/limited', async (c) => {
  const flow = await readFlow(c, 'limited');
  const [reason, until] = (flow?.ref ?? '').split(':');
  const left = Math.ceil((Number(until) - Date.now()) / 1000);
  if (!flow || !isReason(reason) || !(left > 0)) return c.redirect('/sign-in');
  return page(
    c,
    'Too many tries',
    <LimitedStep {...(flow.email ? { email: flow.email } : {})} wait={waitText(left)} reason={reason} next={safeNext(flow.next)} />,
    429,
  );
});

signInRoutes.get('/sign-up', async (c) => {
  if (c.get('user')) return c.redirect('/app');
  if (!(await instanceClaimed(c.env))) return c.redirect('/setup');
  return page(c, 'Accounts are by invite', <InviteOnly />);
});

// The dashboard's own sign-out form posts to the second address.
signInRoutes.on('POST', ['/sign-out', '/api/auth/sign-out'], async (c) => {
  await signOut(c);
  return c.redirect('/sign-in', 303);
});
