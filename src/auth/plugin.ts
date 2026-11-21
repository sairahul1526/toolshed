/**
 * Our own Better Auth plugin. Its endpoints are server-only: they have no URL and can only be
 * called from this codebase through `auth.api.*`, after the caller has already proved who the
 * person is (an emailed code, a one-time link, the first-run claim or an accepted invite).
 */
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { z } from 'zod';
import { randomToken } from '../core/db';
import { hmac, safeEqual } from './crypto';

/** Cookie names the two-factor plugin uses. Kept in step with it by the two-step tests. */
const TWO_FACTOR_COOKIE = 'two_factor';
const TRUST_DEVICE_COOKIE = 'trust_device';
const TWO_STEP_WINDOW_SEC = 10 * 60;

export const toolshed = (db: D1Database) =>
  ({
    id: 'toolshed',
    init() {
      return {
        options: {
          databaseHooks: {
            session: {
              create: {
                /** Every new session starts in the person's first workspace, however they signed in. */
                async before(session) {
                  if (session.activeOrganizationId) return;
                  const first = await db
                    .prepare('SELECT "organizationId" AS id FROM "member" WHERE "userId" = ?1 ORDER BY "createdAt", "id" LIMIT 1')
                    .bind(session.userId)
                    .first<{ id: string }>();
                  if (!first) return;
                  return { data: { ...session, activeOrganizationId: first.id } };
                },
              },
            },
          },
        },
      };
    },
    endpoints: {
      /**
       * Start a session for someone who has passed the first step. When they have two-step
       * sign-in on and this browser is not trusted, no session is made: the two-factor plugin's
       * own "pending" cookie is set instead and the caller must send them to the two-step page.
       */
      issueSession: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({
            userId: z.string(),
            /** False only for flows that are themselves a second factor or must never be blocked. */
            twoStep: z.boolean().default(true),
          }),
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.findUserById(ctx.body.userId);
          if (!user) throw new APIError('BAD_REQUEST', { message: 'No such user.' });

          const needsTwoStep = ctx.body.twoStep && (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled === true;
          if (needsTwoStep && !(await trustedDevice(ctx, user.id))) {
            const pending = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE, { maxAge: TWO_STEP_WINDOW_SEC });
            const identifier = `2fa-${randomToken(15)}`;
            const expiresAt = new Date(Date.now() + TWO_STEP_WINDOW_SEC * 1000);
            await ctx.context.internalAdapter.createVerificationValue({ value: user.id, identifier, expiresAt });
            await ctx.context.internalAdapter.createVerificationValue({ value: '0', identifier: `2fa-attempts-${identifier}`, expiresAt });
            await ctx.setSignedCookie(pending.name, identifier, ctx.context.secret, pending.attributes);
            return ctx.json({ twoStep: true as const, sessionId: null });
          }

          const session = await ctx.context.internalAdapter.createSession(user.id);
          if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'Could not start a session.' });
          await setSessionCookie(ctx, { session, user });
          return ctx.json({ twoStep: false as const, sessionId: session.id });
        },
      ),

      /** Create an account whose email has just been proved. Never reachable over HTTP. */
      createAccount: createAuthEndpoint.serverOnly(
        {
          method: 'POST',
          body: z.object({ email: z.string(), name: z.string(), instanceOwner: z.boolean().default(false) }),
        },
        async (ctx) => {
          const user = await ctx.context.internalAdapter.createUser(
            {
              email: ctx.body.email.toLowerCase(),
              name: ctx.body.name,
              emailVerified: true,
              role: ctx.body.instanceOwner ? 'admin' : 'user',
            },
            { method: 'email-otp' },
          );
          return ctx.json({ id: user.id });
        },
      ),
    },
  }) satisfies BetterAuthPlugin;

type EndpointContext = Parameters<Parameters<typeof createAuthEndpoint.serverOnly>[1]>[0];

/** True when this browser holds a valid "trust this device" cookie for the user. */
async function trustedDevice(ctx: EndpointContext, userId: string): Promise<boolean> {
  const cookie = ctx.context.createAuthCookie(TRUST_DEVICE_COOKIE);
  const value = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
  if (!value) return false;
  const [token, identifier] = value.split('!');
  if (!token || !identifier) return false;
  if (!(await safeEqual(token, await hmac(ctx.context.secret, `${userId}!${identifier}`)))) return false;
  const record = await ctx.context.internalAdapter.findVerificationValue(identifier);
  return !!record && record.value === userId && new Date(record.expiresAt).getTime() > Date.now();
}
