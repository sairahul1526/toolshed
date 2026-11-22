/**
 * Two-step sign-in with an authenticator app, and the one-time recovery codes that go with it.
 * Better Auth's two-factor plugin keeps the secret (encrypted) and checks the codes; this file
 * adds who may call it, the audit trail and the QR code.
 */
import type { Context } from 'hono';
import { renderSVG } from 'uqr';
import { errors } from '../../core/errors';
import type { AppEnv } from '../../env';
import { getAuth } from '../auth';
import { callAuth, type AuthReply } from '../bridge';
import { fingerprint } from '../crypto';
import { authErrors } from '../errors';
import { forwardCookies, hit } from '../http';
import { auditBy, freshFrom, type SignedIn } from './actor';
import { FORGET_TRUSTED_DEVICES } from './sessions';

export interface TwoStepSetup {
  /** The key to type in by hand when the camera will not read the QR code. */
  secret: string;
  /** The `otpauth://` address the QR code holds. */
  uri: string;
  /** The QR code as an SVG picture, drawn here so nothing is sent to another site. */
  qrSvg: string;
  /** Shown once. Each works one time in place of an authenticator code. */
  recoveryCodes: string[];
}

export interface PasswordCheck {
  /** Needed only by accounts that have a password. */
  password?: string;
}

/** A password guess counts against the same limit as a guess on the sign-in page. */
async function guardPassword(c: Context<AppEnv>, actor: SignedIn, input: PasswordCheck): Promise<Record<string, string>> {
  if (!input.password) return {};
  if (await hit(c.env, 'passwordPerAccount', await fingerprint(c.env.AUTH_SECRET, actor.email))) throw errors.rate_limited();
  return { password: input.password.slice(0, 1024) };
}

function fail(reply: AuthReply<unknown>): never {
  if (reply.code === 'INVALID_PASSWORD') throw authErrors.password_wrong();
  if (reply.code === 'INVALID_CODE') throw authErrors.two_step_wrong();
  if (reply.code === 'TOTP_NOT_ENABLED' || reply.code === 'TWO_FACTOR_NOT_ENABLED') throw authErrors.two_step_off();
  if (reply.code === 'TOTP_ALREADY_ENABLED') throw authErrors.two_step_on();
  if (reply.code === 'ACCOUNT_TEMPORARILY_LOCKED' || reply.code === 'TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE') throw authErrors.two_step_locked();
  if (reply.status === 401) throw errors.unauthorized();
  throw errors.internal();
}

/**
 * Begin turning two-step sign-in on. Nothing changes for sign-in until `confirmTwoStep` has seen
 * a code from the app, so a half-finished set-up cannot lock anyone out.
 */
export async function startTwoStep(c: Context<AppEnv>, input: PasswordCheck = {}): Promise<TwoStepSetup> {
  const actor = await freshFrom(c);
  const body = await guardPassword(c, actor, input);
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth<{ totpURI?: string; backupCodes?: string[] }>(() =>
    auth.api.enableTwoFactor({ body, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok || !reply.data?.totpURI) fail(reply);
  forwardCookies(c, reply.cookies);
  const uri = reply.data.totpURI;
  return {
    secret: new URL(uri).searchParams.get('secret') ?? '',
    uri,
    qrSvg: renderSVG(uri, { border: 2 }),
    recoveryCodes: reply.data.backupCodes ?? [],
  };
}

/** Finish turning two-step sign-in on by proving the authenticator app works. */
export async function confirmTwoStep(c: Context<AppEnv>, input: { code: string }): Promise<void> {
  const actor = await freshFrom(c);
  const code = String(input.code ?? '').replace(/\s/g, '').slice(0, 12);
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth(() => auth.api.verifyTOTP({ body: { code }, headers: c.req.raw.headers, asResponse: true }));
  if (!reply.ok) fail(reply);
  // Better Auth swaps the session for a new one here; the browser needs its cookie.
  forwardCookies(c, reply.cookies);
  await auditBy(c.env, actor, { orgId: null, action: 'two_step.turned_on', targetType: 'user', targetId: actor.id, summary: 'Turned on two-step sign-in' });
}

/** Turn two-step sign-in off and throw away the secret and the recovery codes. */
export async function turnOffTwoStep(c: Context<AppEnv>, input: PasswordCheck = {}): Promise<void> {
  const actor = await freshFrom(c);
  const body = await guardPassword(c, actor, input);
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth(() => auth.api.disableTwoFactor({ body, headers: c.req.raw.headers, asResponse: true }));
  if (!reply.ok) fail(reply);
  forwardCookies(c, reply.cookies);
  // Better Auth forgets only the browser that asked. The rest would skip the check if it is turned on again.
  await c.env.DB.prepare(FORGET_TRUSTED_DEVICES).bind(actor.id).run();
  await auditBy(c.env, actor, { orgId: null, action: 'two_step.turned_off', targetType: 'user', targetId: actor.id, summary: 'Turned off two-step sign-in' });
}

/** Make a new set of recovery codes. The old ones stop working at once. */
export async function regenerateRecoveryCodes(c: Context<AppEnv>, input: PasswordCheck = {}): Promise<string[]> {
  const actor = await freshFrom(c);
  const body = await guardPassword(c, actor, input);
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth<{ backupCodes?: string[] }>(() => auth.api.generateBackupCodes({ body, headers: c.req.raw.headers, asResponse: true }));
  if (!reply.ok || !reply.data?.backupCodes) fail(reply);
  // New codes are asked for when the old ones may have been seen. Trusted browsers go the same way.
  await c.env.DB.prepare(FORGET_TRUSTED_DEVICES).bind(actor.id).run();
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'two_step.codes_regenerated',
    targetType: 'user',
    targetId: actor.id,
    summary: 'Made new recovery codes',
  });
  return reply.data.backupCodes;
}
