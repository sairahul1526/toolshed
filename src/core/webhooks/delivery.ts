/**
 * Sending, retrying and recording. A delivery is one event for one endpoint.
 *
 * - `deliverWebhook` makes one try. A bad answer is recorded and a retry is queued; it never throws.
 * - Tries are claimed with one atomic update, so a job handed out twice sends once.
 * - Waits longer than the queue's 12 hour limit are made of several hops.
 * - A sweeper picks up deliveries whose job was lost, so nothing waits forever.
 */
import type { Env } from '../../env';
import { newId } from '../db';
import { errors } from '../errors';
import { enqueue, registerCoreJob, registerCoreSchedule } from '../jobs';
import { performAttempt } from './attempt';
import { disableEndpoint } from './disable';
import { healthStatement } from './health';
import { webhookErrors } from './errors';
import { buildBody } from './payload';
import { type DeliveryRow, type EndpointRow, toDelivery } from './rows';
import { loadEndpointRow } from './store';
import {
  AUTO_DISABLE_AFTER_MS,
  type AttemptResult,
  MAX_ATTEMPTS,
  MAX_QUEUE_DELAY_SECONDS,
  RETRY_DELAYS_SECONDS,
  type WebhookDelivery,
} from './types';

/** A claimed try that never reports back is taken up again by the sweeper after this long. */
const LEASE_MS = 10 * 60_000;
/** The sweeper looks at deliveries this far past due, so it never races a job that is merely queued. */
const SWEEP_GRACE_MS = 5 * 60_000;
const SWEEP_BATCH = 200;

const GONE_REASON = 'The receiver answered 410 Gone, which means it no longer wants these events.';
const FAILING_REASON = 'Every try failed for 3 days in a row.';

interface DeliverJob {
  deliveryId: string;
  /** The try count the job expects to find. A job that no longer matches is stale and does nothing. */
  expect: number;
  /** When the try is due (ms). */
  dueAt: number;
  /** True when the wait was cut to the queue limit, so the job must wait again when it wakes. */
  more: boolean;
}

export async function enqueueDelivery(env: Env, deliveryId: string, expect: number, dueAt: number, now: number): Promise<void> {
  const wait = Math.max(0, Math.ceil((dueAt - now) / 1000));
  const job: DeliverJob = { deliveryId, expect, dueAt, more: wait > MAX_QUEUE_DELAY_SECONDS };
  await enqueue(env, 'core.webhook.deliver', job, wait > 0 ? { delaySeconds: Math.min(wait, MAX_QUEUE_DELAY_SECONDS) } : {});
}

registerCoreJob('webhook.deliver', async (env, payload) => {
  const job = payload as DeliverJob;
  const now = Date.now();
  if (job.more && job.dueAt - now > 1000) {
    await enqueueDelivery(env, job.deliveryId, job.expect, job.dueAt, now);
    return;
  }
  await deliverWebhook(env, job.deliveryId, now, job.expect);
});

/** Write the attempt, the delivery's new state and (for real deliveries) the endpoint's health, in one batch. */
async function settle(env: Env, endpoint: EndpointRow, delivery: DeliveryRow, r: AttemptResult, now: number, live: boolean): Promise<void> {
  const tries = delivery.attempt_count;
  const gone = r.statusCode === 410;
  const final = r.ok || gone || !live || tries >= MAX_ATTEMPTS;
  const status = r.ok ? 'success' : final ? 'failed' : 'pending';
  const dueAt = final ? null : now + RETRY_DELAYS_SECONDS[tries - 1]! * 1000;

  const statements = [
    env.DB.prepare(
      `INSERT INTO webhook_attempts (id, org_id, delivery_id, attempt, status_code, duration_ms, error_code, response_snippet, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(newId('wha', now), delivery.org_id, delivery.id, tries, r.statusCode, r.durationMs, r.errorCode, r.responseSnippet, now),
    env.DB.prepare(
      `UPDATE webhook_deliveries SET status = ?2, last_status_code = ?3, last_error = ?4, next_attempt_at = ?5, completed_at = ?6, updated_at = ?7 WHERE id = ?1`,
    ).bind(delivery.id, status, r.statusCode, r.errorCode, dueAt, final ? now : null, now),
  ];
  if (live) statements.push(healthStatement(env, endpoint, r.ok, now));
  const out = await env.DB.batch(statements);
  if (!live || r.ok) return;

  const failingSince = (out[2]?.results[0] as { failing_since: number | null } | undefined)?.failing_since ?? now;
  const reason = gone ? GONE_REASON : now - failingSince >= AUTO_DISABLE_AFTER_MS ? FAILING_REASON : null;
  if (reason) {
    await disableEndpoint(env, endpoint, reason, now);
    return;
  }
  if (dueAt !== null) {
    try {
      await enqueueDelivery(env, delivery.id, tries, dueAt, now);
    } catch (err) {
      // The sweeper finds it once it is overdue.
      console.error('[webhooks] could not queue a retry', err);
    }
  }
}

/** Fail a delivery without a try, for an endpoint that is gone, paused or off. */
async function skip(env: Env, delivery: DeliveryRow, code: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'failed', last_error = ?2, next_attempt_at = NULL, completed_at = ?3, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(delivery.id, code, now)
    .run();
}

/**
 * Make one try for a delivery. Returns what came of it, or null when there was nothing to do: the
 * delivery is finished, another job already took this try, or the endpoint is paused, off or gone.
 * `expectAttempt` is how many tries the caller thinks have been made; leave it out to send now.
 */
export async function deliverWebhook(env: Env, deliveryId: string, now = Date.now(), expectAttempt?: number): Promise<AttemptResult | null> {
  const delivery = await env.DB.prepare(
    `UPDATE webhook_deliveries SET attempt_count = attempt_count + 1, next_attempt_at = ?2, updated_at = ?3
     WHERE id = ?1 AND status = 'pending' AND (?4 IS NULL OR attempt_count = ?4) RETURNING *`,
  )
    .bind(deliveryId, now + LEASE_MS, now, expectAttempt ?? null)
    .first<DeliveryRow>();
  if (!delivery) return null;

  const endpoint = await env.DB.prepare('SELECT * FROM webhook_endpoints WHERE org_id = ?1 AND id = ?2').bind(delivery.org_id, delivery.endpoint_id).first<EndpointRow>();
  if (!endpoint || endpoint.status !== 'active') {
    await skip(env, delivery, endpoint ? `endpoint_${endpoint.status}` : 'endpoint_deleted', now);
    return null;
  }
  const result = await performAttempt(env, endpoint, delivery, now);
  await settle(env, endpoint, delivery, result, now, true);
  return result;
}

/**
 * Send a test event now and wait for the answer. Works while the endpoint is paused, is refused
 * when it is disabled, makes one try with no retries, and does not count toward the endpoint's
 * failure streak. The result shows in the delivery log.
 */
export async function sendTestEvent(env: Env, orgId: string, endpointId: string, now = Date.now()): Promise<{ delivery: WebhookDelivery; result: AttemptResult }> {
  const endpoint = await loadEndpointRow(env, orgId, endpointId);
  if (endpoint.status === 'disabled') throw webhookErrors.endpoint_disabled();
  const eventId = newId('evt', now);
  const body = buildBody({
    id: eventId,
    type: 'webhook.test',
    at: now,
    orgId,
    subject: endpoint.id,
    data: { message: 'This is a test event from Toolshed. Your endpoint is set up correctly if you can read this.' },
  });
  const row = await env.DB.prepare(
    `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, message_id, event_type, status, attempt_count, next_attempt_at, payload, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, 'webhook.test', 'pending', 1, ?5, ?6, ?7, ?7) RETURNING *`,
  )
    // Due at the end of the lease, so the sweeper can find a test whose isolate died before it was settled.
    .bind(newId('whd', now), orgId, endpoint.id, eventId, now + LEASE_MS, body, now)
    .first<DeliveryRow>();
  const result = await performAttempt(env, endpoint, row!, now);
  await settle(env, endpoint, row!, result, now, false);
  const stored = await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE id = ?1').bind(row!.id).first<DeliveryRow>();
  return { delivery: toDelivery(stored!), result };
}

/**
 * Send a finished delivery again: same event, same `webhook-id`, a fresh set of tries. Refused
 * while it is still being tried, or when the endpoint is paused or disabled.
 */
export async function resendDelivery(env: Env, orgId: string, deliveryId: string, now = Date.now()): Promise<WebhookDelivery> {
  const current = await env.DB.prepare('SELECT * FROM webhook_deliveries WHERE org_id = ?1 AND id = ?2').bind(orgId, deliveryId).first<DeliveryRow>();
  if (!current) throw errors.not_found('We couldn’t find that delivery. Deliveries are kept for 30 days.');
  if (current.status === 'pending') throw webhookErrors.delivery_pending();
  const endpoint = await loadEndpointRow(env, orgId, current.endpoint_id);
  if (endpoint.status === 'disabled') throw webhookErrors.endpoint_disabled();
  if (endpoint.status === 'paused') throw errors.conflict('This endpoint is paused. Turn it back on, then send the event again.');
  const row = await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'pending', attempt_count = 0, last_status_code = NULL, last_error = NULL, next_attempt_at = ?3, completed_at = NULL, updated_at = ?3
     WHERE org_id = ?1 AND id = ?2 AND status != 'pending' RETURNING *`,
  )
    .bind(orgId, deliveryId, now)
    .first<DeliveryRow>();
  // Someone else sent it again a moment ago.
  if (!row) throw webhookErrors.delivery_pending();
  await enqueueDelivery(env, row.id, 0, now, now);
  return toDelivery(row);
}

/** A test is never retried, so one still pending long after it was sent is closed instead of sent again. */
async function closeStaleTests(env: Env, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE webhook_deliveries SET status = 'failed', last_error = 'test_interrupted', next_attempt_at = NULL, completed_at = ?2, updated_at = ?2
     WHERE status = 'pending' AND event_type = 'webhook.test' AND next_attempt_at <= ?1`,
  )
    .bind(now - SWEEP_GRACE_MS, now)
    .run();
}

/** Queue a job again for deliveries that are overdue and have no job. Returns how many it queued. */
export async function sweepDeliveries(env: Env, now = Date.now()): Promise<number> {
  await closeStaleTests(env, now);
  const { results } = await env.DB.prepare(
    `UPDATE webhook_deliveries SET next_attempt_at = ?2 + ?3
     WHERE id IN (SELECT id FROM webhook_deliveries WHERE status = 'pending' AND next_attempt_at <= ?1 LIMIT ${SWEEP_BATCH})
     RETURNING id, attempt_count`,
  )
    .bind(now - SWEEP_GRACE_MS, now, LEASE_MS)
    .all<{ id: string; attempt_count: number }>();
  for (const r of results) await enqueueDelivery(env, r.id, r.attempt_count, now, now);
  return results.length;
}

registerCoreSchedule({ name: 'webhook-sweep', every: '5min', run: async (env, at) => void (await sweepDeliveries(env, at.getTime())) });
