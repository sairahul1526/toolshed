/**
 * The one place Better Auth is configured. Everything else in the app talks to it through
 * `getAuth(env, origin)`, never by importing Better Auth directly, so the settings that matter for
 * security (hashing, cookies, client IP, what is switched off) live in one file.
 *
 * Better Auth owns credentials and sessions: users, session cookies, passwords, passkeys and
 * two-step codes. Email codes, the first-run claim and the workspace rules are ours (see
 * `codes.ts` and `service/`), because they need guarantees Better Auth's plugins do not give:
 * one-time links that a mail scanner cannot burn, no account enumeration, and "a workspace always
 * has an owner" checked in the same statement that changes a role.
 */
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { admin } from 'better-auth/plugins/admin';
import { organization } from 'better-auth/plugins/organization';
import { twoFactor } from 'better-auth/plugins/two-factor';
import { username } from 'better-auth/plugins/username';
import { newId } from '../core/db';
import type { Env } from '../env';
import { IMPERSONATION_TTL_SEC, MIN_PASSWORD_LENGTH, RECOVERY_CODE_COUNT, SESSION_REFRESH_SEC, SESSION_TTL_SEC, TRUST_DEVICE_SEC } from './config';
import { betterAuthPasswordHasher, iterationsFromEnv, MAX_PASSWORD_LENGTH } from './hasher';
import { guardInit, type Guarded } from './init-guard';
import { toolshed } from './plugin';

export const APP_NAME = 'Toolshed';
export const COOKIE_PREFIX = 'toolshed';

/** Prefixes for ids Better Auth creates, so they read like every other id in the app. */
const ID_PREFIX: Record<string, string> = {
  user: 'usr',
  session: 'ses',
  account: 'acc',
  verification: 'ver',
  twoFactor: 'tfa',
  passkey: 'pky',
  organization: 'org',
  member: 'mem',
  invitation: 'inv',
};

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function originOf(candidate: string | undefined): URL | null {
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}

const isLocal = (url: URL): boolean => url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);

/**
 * The public address of this install: `APP_URL` when set, otherwise where the request came in.
 * Only the origin is kept, so a path or query in `APP_URL` cannot leak into links.
 *
 * One exception, for a developer's own machine: when `APP_URL` is a local address, a request to
 * the same port under another local name (`localhost` for `127.0.0.1`) keeps its own name.
 * Passkeys need it, because browsers refuse them on a bare IP address. An install with a real
 * address never follows the request, whatever `Host` it claims.
 */
export function baseUrl(env: Env, requestUrl?: string): string {
  const fixed = originOf(env.APP_URL);
  const asked = originOf(requestUrl);
  if (fixed && asked && isLocal(fixed) && isLocal(asked) && fixed.port === asked.port) return asked.origin;
  const url = fixed ?? asked;
  if (!url) throw new Error('APP_URL is not set and there is no request to read an address from.');
  return url.origin;
}

/** Cookies are `Secure` everywhere except plain http on this machine, where browsers would drop them. */
export function secureCookies(origin: string): boolean {
  const url = new URL(origin);
  return !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname));
}

/** The hashing cost an operator chose with `TOOLSHED_PASSWORD_ITERATIONS`, or the default. */
export function passwordIterations(env: Env): number {
  return iterationsFromEnv((env as Env & { TOOLSHED_PASSWORD_ITERATIONS?: string }).TOOLSHED_PASSWORD_ITERATIONS);
}

function build(env: Env, origin: string) {
  return betterAuth({
    appName: APP_NAME,
    baseURL: origin,
    basePath: '/api/auth',
    secret: env.AUTH_SECRET,
    database: env.DB,
    trustedOrigins: [origin],
    emailAndPassword: {
      enabled: true,
      // Accounts are only created by the first-run claim or by accepting an invite.
      disableSignUp: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Must not exceed the hasher's own limit, or the decoy hash for unknown emails would throw.
      maxPasswordLength: MAX_PASSWORD_LENGTH,
      password: betterAuthPasswordHasher({ iterations: passwordIterations(env) }),
      revokeSessionsOnPasswordReset: true,
    },
    session: {
      expiresIn: SESSION_TTL_SEC,
      updateAge: SESSION_REFRESH_SEC,
      // No "fresh session" gate: people here sign in by emailed code, so there is no password to
      // re-enter. Sensitive changes are checked in the service layer instead.
      freshAge: 0,
    },
    account: { accountLinking: { enabled: false } },
    // Limits are enforced in D1 by the app (core/ratelimit) so they hold across instances.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    advanced: {
      cookiePrefix: COOKIE_PREFIX,
      useSecureCookies: secureCookies(origin),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax', path: '/' },
      // Cloudflare sets this header itself; a client cannot forge it. X-Forwarded-For is not trusted.
      ipAddress: { ipAddressHeaders: ['cf-connecting-ip'] },
      database: {
        generateId: ({ model }) => newId(ID_PREFIX[model] ?? 'ba'),
        // The schema is a checked-in migration. Skipping the start-up check saves D1 reads.
        validateSchema: false,
      },
    },
    plugins: [
      username(),
      twoFactor({
        issuer: APP_NAME,
        allowPasswordless: true,
        trustDeviceMaxAge: TRUST_DEVICE_SEC,
        backupCodeOptions: { amount: RECOVERY_CODE_COUNT, storeBackupCodes: 'encrypted' },
      }),
      passkey({ rpName: APP_NAME, rpID: new URL(origin).hostname, origin }),
      organization({
        // Workspace changes go through src/auth/service, which enforces the role rules.
        allowUserToCreateOrganization: false,
        invitationExpiresIn: 7 * 24 * 60 * 60,
      }),
      admin({ defaultRole: 'user', adminRoles: ['admin'], impersonationSessionDuration: IMPERSONATION_TTL_SEC }),
      toolshed(env.DB),
    ],
  });
}

export type Auth = ReturnType<typeof build>;

/**
 * One instance per database binding and public address, for the life of the isolate. Keyed by the
 * binding object so a test's fresh database never meets another test's instance.
 */
const cache = new WeakMap<object, Map<string, Guarded<Auth>>>();

export function getAuth(env: Env, requestUrl?: string): Promise<Auth> {
  const origin = baseUrl(env, requestUrl);
  let byOrigin = cache.get(env.DB);
  if (!byOrigin) cache.set(env.DB, (byOrigin = new Map()));
  let guarded = byOrigin.get(origin);
  if (!guarded) {
    guarded = guardInit(async () => {
      const auth = build(env, origin);
      await auth.$context;
      return auth;
    });
    byOrigin.set(origin, guarded);
  }
  return guarded.get();
}
