/** The delivery log: list with filters, one delivery with its attempts, and the 30 day clean-up. */
import { z } from 'zod';
import type { Env } from '../../env';
import { parseJson } from '../db';
import { errors, parse } from '../errors';
import { registerCoreSchedule } from '../jobs';
import { type DeliveryRow, toDelivery } from './rows';
import { type DeliveryDetail, DELIVERY_KEEP_DAYS, type WebhookDelivery } from './types';

const querySchema = z.object({
  endpoint: z.string().regex(/^whe_[a-z0-9]+$/, 'That isn’t a webhook endpoint id.').optional(),
  status: z.enum(['pending', 'success', 'failed'], 'Use pending, success or failed.').optional(),
  event: z.string().max(100, 'Keep the event name under 100 characters.').optional(),
  cursor: z.string().regex(/^whd_[a-z0-9]+$/, 'That page marker isn’t valid. Start again from the first page.').optional(),
  limit: z.coerce.number('Use a number from 1 to 100.').int().min(1, 'Use a number from 1 to 100.').max(100, 'Use a number from 1 to 100.').default(50),
});

export interface DeliveryList {
  deliveries: WebhookDelivery[];
  /** Pass as `cursor` to get the next page. Null on the last page. */
  nextCursor: string | null;
}

/** Newest first. Ids sort by time, so the cursor is simply the last id of the page before. */
export async function listDeliveries(env: Env, orgId: string, query: unknown = {}): Promise<DeliveryList> {
  const q = parse(querySchema, query);
  const where = ['org_id = ?1'];
  const params: (string | number)[] = [orgId];
  const add = (sql: string, value: string | undefined) => {
    if (value === undefined) return;
    params.push(value);
    where.push(sql.replace('?', `?${params.length}`));
  };
  add('endpoint_id = ?', q.endpoint);
  add('status = ?', q.status);
  add('event_type = ?', q.event);
  add('id < ?', q.cursor);
  const { results } = await env.DB.prepare(`SELECT * FROM webhook_deliveries WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ${q.limit + 1}`)
    .bind(...params)
    .all<DeliveryRow>();
  const page = results.slice(0, q.limit);
  return { deliveries: page.map(toDelivery), nextCursor: results.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
}

export async function getDelivery(env: Env, orgId: string, id: string): Promise<DeliveryDetail> {
  const [row, attempts] = await Promise.all([
    env.DB.prepare('SELECT * FROM webhook_deliveries WHERE org_id = ?1 AND id = ?2').bind(orgId, id).first<DeliveryRow>(),
    env.DB.prepare(
      `SELECT attempt, status_code, duration_ms, error_code, response_snippet, created_at FROM webhook_attempts
       WHERE org_id = ?1 AND delivery_id = ?2 ORDER BY created_at, id`,
    )
      .bind(orgId, id)
      .all<{ attempt: number; status_code: number | null; duration_ms: number; error_code: string | null; response_snippet: string | null; created_at: number }>(),
  ]);
  if (!row) throw errors.not_found('We couldn’t find that delivery. Deliveries are kept for 30 days.');
  return {
    ...toDelivery(row),
    payload: parseJson<unknown>(row.payload, null),
    attempts: attempts.results.map((a) => ({
      attempt: a.attempt,
      statusCode: a.status_code,
      durationMs: a.duration_ms,
      errorCode: a.error_code,
      responseSnippet: a.response_snippet,
      at: a.created_at,
    })),
  };
}

const PURGE_BATCH = 1000;

/** Delete deliveries older than 30 days, with their attempts, in slices so no single statement grows large. Returns how many went. */
export async function purgeOldDeliveries(env: Env, now = Date.now()): Promise<number> {
  const cutoff = now - DELIVERY_KEEP_DAYS * 86_400_000;
  let total = 0;
  for (let round = 0; round < 50; round++) {
    const [, gone] = await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM webhook_attempts WHERE delivery_id IN (SELECT id FROM webhook_deliveries WHERE created_at < ?1 ORDER BY created_at LIMIT ${PURGE_BATCH})`,
      ).bind(cutoff),
      env.DB.prepare(
        `DELETE FROM webhook_deliveries WHERE id IN (SELECT id FROM webhook_deliveries WHERE created_at < ?1 ORDER BY created_at LIMIT ${PURGE_BATCH})`,
      ).bind(cutoff),
    ]);
    const n = gone?.meta.changes ?? 0;
    total += n;
    if (n < PURGE_BATCH) break;
  }
  return total;
}

registerCoreSchedule({ name: 'webhook-cleanup', every: 'day', run: async (env, at) => void (await purgeOldDeliveries(env, at.getTime())) });
