/**
 * REST API for outgoing webhooks, mounted at /api/v1/webhooks.
 *
 *   GET    /events                      every event an endpoint can subscribe to
 *   GET    /                            list endpoints
 *   POST   /                            add an endpoint; the signing secret is in this response
 *   GET    /:id                         one endpoint (never shows the secret or header values)
 *   PATCH  /:id                         change name, url, events, headers, or status (active | paused)
 *   DELETE /:id                         delete it and its delivery log
 *   GET    /:id/secret                  show the signing secret again (signed-in people only)
 *   POST   /:id/rotate                  make a new secret; the old one keeps working for 24 hours (signed-in people only)
 *   POST   /:id/test                    send a test event now and return the answer
 *   GET    /deliveries                  the log: ?endpoint=&status=&event=&cursor=&limit=
 *   GET    /deliveries/:id              one delivery with every try
 *   POST   /deliveries/:id/resend       send it again
 *
 * Workspace admins only. Reading needs the `webhooks:read` scope, changing needs `webhooks:write`
 * (the `*` scope and signed-in people have both). Secrets are only for signed-in people.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import type { CoreRoutes } from '../../app';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../audit';
import { errors, readJson } from '../errors';
import { hasScope, needRole, refuseWhileImpersonating } from '../guards';
import { enforceRateLimit } from '../ratelimit';
import {
  createEndpoint,
  deleteEndpoint,
  eventCatalog,
  getDelivery,
  getEndpoint,
  listDeliveries,
  listEndpoints,
  resendDelivery,
  revealEndpointSecret,
  rotateEndpointSecret,
  sendTestEvent,
  updateEndpoint,
  webhookErrors,
} from '../webhooks';
import type { Actor, WebhookEndpoint } from '../webhooks';

const api = new Hono<AppEnv>();

api.use('*', async (c, next) => {
  needRole(c, 'admin');
  const scope = c.req.method === 'GET' || c.req.method === 'HEAD' ? 'webhooks:read' : 'webhooks:write';
  if (!hasScope(c.get('auth').scopes, scope)) throw errors.forbidden(`This key doesn’t have the ${scope} permission.`);
  await next();
  // Responses can hold a signing secret. Nothing between us and the caller may keep a copy.
  c.header('cache-control', 'no-store');
});

const orgOf = (c: Context<AppEnv>): string => c.get('org')!.id;

function actorOf(c: Context<AppEnv>): Actor {
  const user = c.get('user');
  return { userId: user?.id ?? c.get('auth').keyId ?? '', label: user ? user.name || user.email : null };
}

/** Reading or replacing a signing secret: a signed-in person, and not an install owner acting as them. */
function needSession(c: Context<AppEnv>): void {
  if (c.get('auth').kind !== 'session') throw webhookErrors.session_required();
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
}

const describe = (e: WebhookEndpoint): string => `“${e.name}”`;

api.get('/events', (c) => c.json({ events: eventCatalog() }));

api.get('/', async (c) => c.json({ endpoints: await listEndpoints(c.env, orgOf(c)) }));

api.post('/', async (c) => {
  // A new endpoint keeps receiving this workspace's events, and its secret is in the response.
  refuseWhileImpersonating(c.get('auth').impersonatedBy);
  await enforceRateLimit(c.env, `webhooks.create:${orgOf(c)}`, { limit: 20, windowSec: 3600 });
  const { endpoint, secret } = await createEndpoint(c.env, orgOf(c), actorOf(c), await readJson(c));
  await auditFromRequest(c, {
    action: 'webhook.created',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `Added the webhook endpoint ${describe(endpoint)}`,
    meta: { events: endpoint.events },
  });
  return c.json({ endpoint, secret }, 201);
});

api.get('/deliveries', async (c) => c.json(await listDeliveries(c.env, orgOf(c), c.req.query())));

api.get('/deliveries/:id', async (c) => c.json({ delivery: await getDelivery(c.env, orgOf(c), c.req.param('id')) }));

api.post('/deliveries/:id/resend', async (c) => {
  await enforceRateLimit(c.env, `webhooks.resend:${orgOf(c)}`, { limit: 60, windowSec: 600 });
  const delivery = await resendDelivery(c.env, orgOf(c), c.req.param('id'));
  await auditFromRequest(c, {
    action: 'webhook.delivery_resent',
    targetType: 'webhook_delivery',
    targetId: delivery.id,
    summary: `Sent the event ${delivery.eventType} again`,
    meta: { endpointId: delivery.endpointId },
  });
  return c.json({ delivery }, 202);
});

api.get('/:id', async (c) => c.json({ endpoint: await getEndpoint(c.env, orgOf(c), c.req.param('id')) }));

api.patch('/:id', async (c) => {
  const body = await readJson(c);
  // A rename is harmless. A changed address, event list or on/off switch would
  // keep sending after a "sign in as" hour ends.
  const renameOnly = typeof body === 'object' && body !== null && Object.keys(body).every((k) => k === 'name');
  if (!renameOnly) refuseWhileImpersonating(c.get('auth').impersonatedBy);
  const { endpoint, changed } = await updateEndpoint(c.env, orgOf(c), c.req.param('id'), body);
  if (changed.length > 0) {
    await auditFromRequest(c, {
      action: 'webhook.updated',
      targetType: 'webhook_endpoint',
      targetId: endpoint.id,
      summary: `Changed the webhook endpoint ${describe(endpoint)}`,
      meta: { fields: changed },
    });
  }
  return c.json({ endpoint });
});

api.delete('/:id', async (c) => {
  const endpoint = await getEndpoint(c.env, orgOf(c), c.req.param('id'));
  await deleteEndpoint(c.env, orgOf(c), endpoint.id);
  await auditFromRequest(c, {
    action: 'webhook.deleted',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `Deleted the webhook endpoint ${describe(endpoint)}`,
  });
  return c.json({ ok: true });
});

api.get('/:id/secret', async (c) => {
  needSession(c);
  const endpoint = await getEndpoint(c.env, orgOf(c), c.req.param('id'));
  const { secret } = await revealEndpointSecret(c.env, orgOf(c), endpoint.id);
  await auditFromRequest(c, {
    action: 'webhook.secret_viewed',
    targetType: 'webhook_endpoint',
    targetId: endpoint.id,
    summary: `Viewed the signing secret of ${describe(endpoint)}`,
  });
  return c.json({ secret });
});

api.post('/:id/rotate', async (c) => {
  needSession(c);
  await enforceRateLimit(c.env, `webhooks.rotate:${orgOf(c)}`, { limit: 10, windowSec: 3600 });
  const rotated = await rotateEndpointSecret(c.env, orgOf(c), c.req.param('id'));
  await auditFromRequest(c, {
    action: 'webhook.secret_rotated',
    targetType: 'webhook_endpoint',
    targetId: rotated.endpoint.id,
    summary: `Made a new signing secret for ${describe(rotated.endpoint)}`,
    meta: { previousSecretExpiresAt: rotated.previousSecretExpiresAt },
  });
  return c.json(rotated);
});

api.post('/:id/test', async (c) => {
  await enforceRateLimit(c.env, `webhooks.test:${orgOf(c)}`, { limit: 20, windowSec: 600 });
  const sent = await sendTestEvent(c.env, orgOf(c), c.req.param('id'));
  await auditFromRequest(c, {
    action: 'webhook.tested',
    targetType: 'webhook_endpoint',
    targetId: sent.delivery.endpointId,
    summary: sent.result.ok ? 'Sent a test event, and the receiver accepted it' : 'Sent a test event, and the receiver did not accept it',
    meta: { statusCode: sent.result.statusCode, errorCode: sent.result.errorCode },
  });
  return c.json(sent);
});

export default { api } satisfies CoreRoutes;
