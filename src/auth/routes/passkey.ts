/**
 * Passkey sign-in and sign-up of a new passkey. These four JSON routes are the only part of
 * `/api/auth/*` that exists: each wraps one Better Auth call, passes its cookies on, and answers
 * with the least the page needs. Session tokens never appear in a response body.
 */
import type { Context } from 'hono';
import { Hono } from 'hono';
import { errors, readJson } from '../../core/errors';
import { sameOrigin } from '../../core/guards';
import type { AppEnv } from '../../env';
import { getAuth } from '../auth';
import { callAuth, type AuthReply } from '../bridge';
import { authErrors } from '../errors';
import { clientIp, forwardCookies, hit } from '../http';
import { safeNext } from '../next';
import { sessionFromRequest } from '../session';
import { auditBy, freshFrom } from '../service/actor';
import { recordSignIn } from '../signin';

type C = Context<AppEnv>;

export const passkeyRoutes = new Hono<AppEnv>();

passkeyRoutes.use('/api/auth/*', sameOrigin, async (c, next) => {
  c.header('cache-control', 'no-store');
  await next();
});

/** The WebAuthn answer a browser sends back. Checked in depth by Better Auth; this only bounds it. */
async function ceremonyBody(c: C): Promise<Record<string, unknown>> {
  if (Number(c.req.header('content-length') ?? 0) > 32_000) throw errors.too_large();
  const body = await readJson(c);
  if (!body.response || typeof body.response !== 'object') throw errors.bad_request('Send the passkey response.');
  return body;
}

async function limit(c: C): Promise<void> {
  const wait = await hit(c.env, 'passkeyPerIp', clientIp(c));
  if (wait) throw errors.rate_limited();
}

function relay(c: C, reply: AuthReply<unknown>): void {
  forwardCookies(c, reply.cookies);
}

passkeyRoutes.get('/api/auth/passkey/sign-in-options', async (c) => {
  await limit(c);
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth(() => auth.api.generatePasskeyAuthenticationOptions({ headers: c.req.raw.headers, asResponse: true }));
  if (!reply.ok || !reply.data) throw authErrors.passkey_failed();
  relay(c, reply);
  return c.json(reply.data);
});

passkeyRoutes.post('/api/auth/passkey/sign-in', async (c) => {
  await limit(c);
  const body = await ceremonyBody(c);
  const auth = await getAuth(c.env, c.req.url);
  const before = await sessionFromRequest(c);
  const reply = await callAuth<{ user?: { id: string; email: string } }>(() =>
    auth.api.verifyPasskeyAuthentication({ body: { response: body.response as never }, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok || !reply.data?.user) {
    if (reply.code === 'BANNED_USER') throw authErrors.banned();
    throw authErrors.passkey_failed();
  }
  relay(c, reply);
  // A passkey is already two things at once (the device, and its PIN or fingerprint), so there
  // is no second step after it.
  await recordSignIn(c, reply.data.user, 'passkey', before?.session.id);
  return c.json({ ok: true, redirect: safeNext(body.next) });
});

passkeyRoutes.get('/api/auth/passkey/register-options', async (c) => {
  await freshFrom(c);
  await limit(c);
  const auth = await getAuth(c.env, c.req.url);
  const name = (c.req.query('name') ?? '').trim().slice(0, 60);
  const reply = await callAuth(() =>
    auth.api.generatePasskeyRegistrationOptions({ query: name ? { name } : {}, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok || !reply.data) throw authErrors.passkey_failed();
  relay(c, reply);
  return c.json(reply.data);
});

passkeyRoutes.post('/api/auth/passkey/register', async (c) => {
  const actor = await freshFrom(c);
  await limit(c);
  const body = await ceremonyBody(c);
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 60) : '';
  const auth = await getAuth(c.env, c.req.url);
  const reply = await callAuth<{ id?: string }>(() =>
    auth.api.verifyPasskeyRegistration({ body: { response: body.response as never, ...(name ? { name } : {}) }, headers: c.req.raw.headers, asResponse: true }),
  );
  if (!reply.ok) throw authErrors.passkey_failed();
  relay(c, reply);
  await auditBy(c.env, actor, {
    orgId: null,
    action: 'passkey.added',
    targetType: 'user',
    targetId: actor.id,
    summary: name ? `Added the passkey “${name}”` : 'Added a passkey',
  });
  return c.json({ ok: true });
});
