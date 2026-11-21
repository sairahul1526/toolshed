/**
 * REST API for keys, mounted at /api/v1/keys.
 *
 *   GET    /api/v1/keys                        list keys (?include=revoked for revoked ones too)
 *   POST   /api/v1/keys                        make a key; the secret is in this response only
 *   GET    /api/v1/keys/:id
 *   PATCH  /api/v1/keys/:id                    rename
 *   DELETE /api/v1/keys/:id                    revoke
 *   POST   /api/v1/keys/:id/rotate             replace with a new secret
 *   GET    /api/v1/keys/scopes                 every scope a key can have
 *   GET    /api/v1/keys/service-accounts       plus POST, and PATCH and DELETE on /:id
 *
 * Workspace admins only. Changing anything needs a signed-in person: a key or token can read
 * this API (with Admin role and the `*` scope) but can never make, widen or change a key.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CoreRoutes } from '../../app';
import type { AppEnv } from '../../env';
import {
  createApiKey,
  createServiceAccount,
  deleteServiceAccount,
  getApiKey,
  keyErrors,
  listApiKeys,
  listScopes,
  listServiceAccounts,
  renameApiKey,
  revokeApiKey,
  rotateApiKey,
  updateServiceAccount,
} from '../apikeys';
import type { CreateKeyInput, KeyActor, KeyRole } from '../apikeys';
import { errors, readJson } from '../errors';
import { needRole } from '../guards';

const api = new Hono<AppEnv>();

api.use('*', async (c, next) => {
  needRole(c, 'admin');
  const auth = c.get('auth');
  if (auth.kind !== 'session') {
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') throw keyErrors.session_required();
    if (!auth.scopes.includes('*')) throw errors.forbidden('Reading keys needs the * permission. Use a key that has it, or sign in.');
  }
  await next();
  // A response here can hold a secret. Nothing between us and the caller may keep a copy.
  c.header('cache-control', 'no-store');
});

function actorOf(c: Context<AppEnv>): KeyActor {
  const org = c.get('org');
  const user = c.get('user');
  const auth = c.get('auth');
  if (!org || auth.kind === 'anon') throw errors.unauthorized();
  return {
    orgId: org.id,
    userId: user?.id ?? auth.keyId ?? '',
    role: org.role,
    label: user ? user.name || user.email : null,
    ip: c.req.header('cf-connecting-ip') ?? null,
    via: auth.kind,
  };
}

/** A body is optional on some routes. Nothing sent means an empty object. */
async function optionalJson(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  const text = await c.req.text();
  if (text.trim() === '') return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw errors.bad_request('Send a JSON body, or no body at all.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw errors.bad_request('Send a JSON object.');
  return body as Record<string, unknown>;
}

api.get('/scopes', (c) => c.json({ scopes: listScopes() }));

api.get('/service-accounts', async (c) => c.json({ serviceAccounts: await listServiceAccounts(c.env, actorOf(c)) }));

api.post('/service-accounts', async (c) => {
  const body = await readJson(c);
  const serviceAccount = await createServiceAccount(c.env, actorOf(c), body as { name: string; role: KeyRole });
  return c.json({ serviceAccount }, 201);
});

api.patch('/service-accounts/:id', async (c) => {
  const body = await readJson(c);
  const serviceAccount = await updateServiceAccount(c.env, actorOf(c), c.req.param('id'), body as { name?: string; role?: KeyRole });
  return c.json({ serviceAccount });
});

api.delete('/service-accounts/:id', async (c) => c.json(await deleteServiceAccount(c.env, actorOf(c), c.req.param('id'))));

api.get('/', async (c) => {
  const keys = await listApiKeys(c.env, actorOf(c), { includeRevoked: c.req.query('include') === 'revoked' });
  return c.json({ keys });
});

api.post('/', async (c) => {
  const body = await readJson(c);
  // The body is checked field by field inside createApiKey.
  return c.json(await createApiKey(c.env, actorOf(c), body as unknown as CreateKeyInput), 201);
});

api.get('/:id', async (c) => c.json({ key: await getApiKey(c.env, actorOf(c), c.req.param('id')) }));

api.patch('/:id', async (c) => {
  const body = await readJson(c);
  const unknown = Object.keys(body).filter((k) => k !== 'name');
  if (unknown.length > 0) throw errors.validation_failed('Only the name of a key can be changed. To change anything else, make a new key.', { [unknown[0]!]: 'This can’t be changed.' });
  return c.json({ key: await renameApiKey(c.env, actorOf(c), c.req.param('id'), body.name as string) });
});

api.delete('/:id', async (c) => c.json({ key: await revokeApiKey(c.env, actorOf(c), c.req.param('id')) }));

api.post('/:id/rotate', async (c) => {
  const body = await optionalJson(c);
  return c.json(await rotateApiKey(c.env, actorOf(c), c.req.param('id'), body as { graceSeconds?: number }));
});

export default { api } satisfies CoreRoutes;
