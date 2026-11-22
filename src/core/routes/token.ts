/**
 * Short-lived tokens over HTTP.
 *
 *   POST /api/v1/token            swap a session or an API key for a 15 minute token
 *   GET  /.well-known/jwks.json   the public keys to check tokens with (no sign-in)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { CoreRoutes } from '../../app';
import type { AppEnv } from '../../env';
import { roleAtLeast } from '../../env';
import { capRole, checkScopes, MAX_SCOPES, scopesBeyond } from '../apikeys';
import type { KeyRole } from '../apikeys';
import { defineErrors, errors, parse } from '../errors';
import { refuseWhileImpersonating } from '../guards';
import { getJwks, signJwt, TOKEN_TTL_SECONDS } from '../jwt';
import { roleSchema } from '../keys/shared';
import { enforceRateLimit } from '../ratelimit';

export const tokenErrors = defineErrors('token', {
  not_renewable: { status: 403, message: 'A token can’t be swapped for another token. Use your API key, or sign in, to get a new one.' },
  scope_too_wide: { status: 403, message: 'You asked for permissions you don’t have. Ask for fewer, or leave scopes out to get your own.' },
  role_too_high: { status: 403, message: 'You asked for a stronger role than your own. Ask for a lower role, or leave it out.' },
});

/** Tokens one caller may ask for. A well-behaved client asks about once every 15 minutes. */
const TOKEN_RATE_LIMIT = { limit: 60, windowSec: 60 };

const requestSchema = z.strictObject({
  scopes: z
    .array(z.string('Each permission is a name such as links:read.').max(100, 'That permission name is too long.'), 'Send scopes as a list of names.')
    .min(1, 'Send at least one permission, or leave scopes out to get your own.')
    .max(MAX_SCOPES, `Ask for at most ${MAX_SCOPES} permissions.`)
    .optional(),
  role: roleSchema.optional(),
});

const api = new Hono<AppEnv>();

api.post('/', async (c) => {
  const auth = c.get('auth');
  const org = c.get('org');
  const user = c.get('user');
  if (!org || auth.kind === 'anon') throw errors.unauthorized();
  // A token that could renew itself would never run out. Only the longer-lived credential can ask.
  if (auth.kind === 'jwt') throw tokenErrors.not_renewable();
  // A token lasts 15 minutes whatever happens to the session it came from.
  refuseWhileImpersonating(auth.impersonatedBy);
  const sub = auth.kind === 'apikey' ? auth.keyId : user?.id;
  if (!sub) throw errors.unauthorized();
  await enforceRateLimit(c.env, `token:${sub}`, TOKEN_RATE_LIMIT, 'Too many tokens asked for. A token lasts 15 minutes, so reuse it, then try again.');

  const text = await c.req.text();
  let body: unknown = {};
  if (text.trim() !== '') {
    try {
      body = JSON.parse(text);
    } catch {
      throw errors.bad_request('Send a JSON body, or no body at all.');
    }
  }
  const wanted = parse(requestSchema, body);

  const ceiling = capRole(org.role);
  const role: KeyRole = wanted.role ?? ceiling;
  if (!roleAtLeast(ceiling, role)) throw tokenErrors.role_too_high();

  let scopes = auth.scopes;
  if (wanted.scopes) {
    scopes = checkScopes(wanted.scopes);
    const beyond = scopesBeyond(auth.scopes, scopes);
    if (beyond.length > 0) {
      const message = `You don’t have ${beyond.length === 1 ? 'this permission' : 'these permissions'}: ${beyond.slice(0, 5).join(', ')}. Ask for fewer, or leave scopes out to get your own.`;
      throw tokenErrors.scope_too_wide(message, { scopes: message });
    }
  }

  const { token, expiresAt } = await signJwt(
    c.env,
    { sub, orgId: org.id, role, scopes, kind: auth.kind === 'apikey' ? 'key' : 'user' },
    { issuer: new URL(c.req.url).origin },
  );
  c.header('cache-control', 'no-store');
  return c.json({ token, tokenType: 'Bearer', expiresAt, expiresIn: TOKEN_TTL_SECONDS, role, scopes });
});

const wellKnown = new Hono<AppEnv>();

wellKnown.get('/.well-known/jwks.json', async (c) => {
  // Public keys only. Short cache: after a rotation, verifiers pick up the new key within 5 minutes.
  c.header('cache-control', 'public, max-age=300');
  c.header('access-control-allow-origin', '*');
  return c.json(await getJwks(c.env));
});

export default { api, public: wellKnown } satisfies CoreRoutes;
