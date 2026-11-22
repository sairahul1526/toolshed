/**
 * From an event to deliveries. `queueWebhooks` is called by `emit()`, so it is built to cost
 * nothing for a workspace with no webhooks: one remembered yes-or-no (see active.ts), and one
 * queue message only when there is something to send. The queue job then finds the matching
 * endpoints with a single query and creates every delivery in one batch (no query per endpoint).
 */
import type { Env } from '../../env';
import { newId, parseJson } from '../db';
import { enqueue, registerCoreJob } from '../jobs';
import type { AppEvent } from '../module';
import { hasActiveEndpoints } from './active';
import { matchesEvent } from './catalog';
import { enqueueDelivery } from './delivery';
import { buildBody } from './payload';

/** Queue messages are limited to 128 KB, so a large `data` is dropped here. It would be cut at 256 KB later anyway. */
const MAX_QUEUED_DATA_BYTES = 100 * 1024;

export interface FanoutJob {
  /** Also the `webhook-id` of every delivery, so a repeated job cannot make a second delivery. */
  id: string;
  orgId: string;
  type: string;
  subject: string | null;
  data: Record<string, unknown>;
  at: number;
}

/** Never throws: a webhook problem must not break the feature that raised the event. */
export async function queueWebhooks(env: Env, event: AppEvent): Promise<void> {
  try {
    if (!(await hasActiveEndpoints(env, event.orgId))) return;
    const data = event.data ?? {};
    const job: FanoutJob = {
      id: newId('evt'),
      orgId: event.orgId,
      type: `${event.module}.${event.name}`,
      subject: event.subject ?? null,
      data: JSON.stringify(data).length > MAX_QUEUED_DATA_BYTES ? { truncated: true } : data,
      at: event.at ?? Date.now(),
    };
    await enqueue(env, 'core.webhook.fanout', job);
  } catch (err) {
    console.error('[webhooks] could not queue an event', err);
  }
}

/** Create one pending delivery per matching active endpoint and queue the first try of each. Returns how many. */
export async function fanOut(env: Env, job: FanoutJob, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT id, events FROM webhook_endpoints WHERE org_id = ?1 AND status = 'active'`)
    .bind(job.orgId)
    .all<{ id: string; events: string }>();
  const targets = results.filter((r) => matchesEvent(parseJson<string[]>(r.events, []), job.type));
  if (targets.length === 0) return 0;

  const body = buildBody(job);
  const insert = `INSERT OR IGNORE INTO webhook_deliveries (id, org_id, endpoint_id, message_id, event_type, status, attempt_count, next_attempt_at, payload, created_at, updated_at)
                  VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?6, ?6)`;
  const ids = targets.map(() => newId('whd', now));
  const created = await env.DB.batch(targets.map((t, i) => env.DB.prepare(insert).bind(ids[i], job.orgId, t.id, job.id, job.type, now, body)));
  // A retried job skips the deliveries it already made.
  let queued = 0;
  for (const [i, result] of created.entries()) {
    if ((result.meta.changes ?? 0) === 0) continue;
    await enqueueDelivery(env, ids[i]!, 0, now, now);
    queued++;
  }
  return queued;
}

registerCoreJob('webhook.fanout', async (env, payload) => void (await fanOut(env, payload as FanoutJob)));
