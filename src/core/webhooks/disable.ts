/** Turning an endpoint off because the receiver keeps failing or said it is gone. */
import type { Env } from '../../env';
import { audit } from '../audit';
import { notify } from '../notifications';
import { forgetActiveEndpoints } from './active';
import type { EndpointRow } from './rows';

/**
 * Set the endpoint to `disabled` with a reason, fail what it still had waiting, tell the workspace's
 * admins and write the audit entry. Does nothing when it is already disabled. Re-enabling is manual.
 */
export async function disableEndpoint(env: Env, endpoint: Pick<EndpointRow, 'id' | 'org_id' | 'name'>, reason: string, now: number): Promise<boolean> {
  const res = await env.DB.prepare(
    `UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = ?3, updated_at = ?4 WHERE org_id = ?1 AND id = ?2 AND status != 'disabled'`,
  )
    .bind(endpoint.org_id, endpoint.id, reason, now)
    .run();
  if ((res.meta.changes ?? 0) === 0) return false;
  forgetActiveEndpoints(env, endpoint.org_id);
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'failed', last_error = 'endpoint_disabled', next_attempt_at = NULL, completed_at = ?3, updated_at = ?3
     WHERE org_id = ?1 AND endpoint_id = ?2 AND status = 'pending'`,
  )
    .bind(endpoint.org_id, endpoint.id, now)
    .run();
  try {
    await notify(env, {
      orgId: endpoint.org_id,
      title: 'A webhook endpoint was turned off',
      body: `We stopped sending to “${endpoint.name.slice(0, 80)}”. ${reason} Fix the receiver, then turn it back on.`,
      href: '/app/webhooks',
      kind: 'webhooks',
      dedupeKey: `webhook-disabled:${endpoint.id}:${now}`,
    });
    await audit(env, {
      orgId: endpoint.org_id,
      actorType: 'system',
      actorLabel: 'Webhooks',
      action: 'webhook.disabled',
      targetType: 'webhook_endpoint',
      targetId: endpoint.id,
      summary: `Turned off the webhook endpoint “${endpoint.name.slice(0, 80)}”. ${reason}`,
    });
  } catch (err) {
    // The endpoint is off either way. A failed notice must not make the delivery job fail.
    console.error('[webhooks] could not record that an endpoint was turned off', err);
  }
  return true;
}
