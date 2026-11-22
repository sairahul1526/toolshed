/**
 * The send engine. Built for a free plan: ten milliseconds of CPU and fifty outside calls per run.
 *
 *  1. `startBroadcast` runs the checklist, writes one `queued` delivery row per recipient, and queues a job.
 *  2. Each `mail.send-batch` job takes a short lock, claims a handful of rows, sends them, records what
 *     happened in one write, and queues the next job a couple of seconds later.
 *  3. A watchdog (every minute) restarts a send that stopped, and starts scheduled broadcasts.
 *
 * Resumable and never twice: a delivery row exists once per person (unique index), a claimed row that
 * was never finished is picked up again after a lease, and before resending we ask the delivery log
 * whether that exact message already went out.
 */
import { ensureArchiveSlug } from './archive';
import { enqueue } from '../../core/jobs';
import { newId } from '../../core/db';
import { resolveBrand } from '../../core/email-templates/brand';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { audienceSql, checkBroadcast, getBroadcast } from './broadcasts';
import { composeMessage } from './emails';
import { mailErrors } from './errors';
import { linksIn } from './render';
import { parseFilter } from './segments';
import { coreSender, type Sender } from './sender';
import { getMailSettings, linkBase } from './settings';
import { ctxOf, type Broadcast, type Ctx, type Delivery, type List, type Subscriber } from './types';

export const BATCH_SIZE = 5;
export const BATCH_DELAY_S = 2;
export const LOCK_MS = 90_000;
export const CLAIM_LEASE_MS = 3 * 60_000;
export const STALL_MS = 3 * 60_000;
export const CAP_BACKOFF_MS = 10 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const JOB = 'mail.send-batch';

export interface BatchPayload {
  orgId: string;
  broadcastId: string;
}

const kick = (env: Env, p: BatchPayload, delaySeconds = 0) => enqueue(env, JOB, p, { delaySeconds });

/** Check, freeze the audience, and begin. `scheduled` means "a person asked to send at a time". */
export async function startBroadcast(ctx: Ctx, id: string, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  if (b.status !== 'draft' && b.status !== 'scheduled') throw mailErrors.not_editable();
  const check = await checkBroadcast(ctx, b, now);
  if (!check.ready) throw mailErrors.not_sendable();
  const a = audienceSql(b.list_id, parseFilter(b.filter), now);
  await ctx.db.run(
    `INSERT OR IGNORE INTO mail_deliveries (id, org_id, broadcast_id, subscriber_id, email, status, created_at)
     SELECT 'mdl_' || lower(hex(randomblob(10))), s.org_id, ?, s.id, s.email, 'queued', ? ${a.sql}`,
    b.id,
    now,
    ...a.params,
  );
  if (b.in_archive) await ensureArchiveSlug(ctx, b);
  if (b.track_clicks) {
    const urls = linksIn(b);
    if (urls.length) {
      await ctx.db.d1.batch(
        urls.slice(0, 80).map((url) => ctx.db.d1.prepare('INSERT OR IGNORE INTO mail_links (id, org_id, broadcast_id, url, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(newId('mlk', now), ctx.org.id, b.id, url, now)),
      );
    }
  }
  await ctx.db.run(
    `UPDATE mail_broadcasts SET status = 'sending', started_at = COALESCE(started_at, ?), heartbeat_at = ?, next_run_at = NULL, lock_until = NULL, last_error = '', updated_at = ?,
       total = (SELECT COUNT(*) FROM mail_deliveries WHERE org_id = :org AND broadcast_id = ?)
     WHERE org_id = :org AND id = ?`,
    now,
    now,
    now,
    b.id,
    b.id,
  );
  await kick(ctx.env, { orgId: ctx.org.id, broadcastId: b.id });
  return getBroadcast(ctx, id);
}

export async function scheduleBroadcast(ctx: Ctx, id: string, at: number, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  if (b.status !== 'draft' && b.status !== 'scheduled') throw mailErrors.not_editable();
  if (!Number.isFinite(at) || at < now + 60_000) throw (await import('../../core/errors')).errors.validation_failed('Pick a time at least a minute from now.', { at: 'Pick a later time.' });
  const check = await checkBroadcast(ctx, b, now);
  if (!check.ready) throw mailErrors.not_sendable();
  await ctx.db.update('mail_broadcasts', id, { status: 'scheduled', scheduled_at: at, updated_at: now });
  await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'broadcast.scheduled', subject: id, data: { subject: b.subject, at }, at: now });
  return getBroadcast(ctx, id);
}

export async function unscheduleBroadcast(ctx: Ctx, id: string, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  if (b.status !== 'scheduled') throw mailErrors.not_editable();
  return (await ctx.db.update<Broadcast>('mail_broadcasts', id, { status: 'draft', scheduled_at: null, updated_at: now }))!;
}

export async function pauseBroadcast(ctx: Ctx, id: string, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  if (b.status !== 'sending') throw mailErrors.not_editable();
  return (await ctx.db.update<Broadcast>('mail_broadcasts', id, { status: 'paused', updated_at: now }))!;
}

export async function resumeBroadcast(ctx: Ctx, id: string, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  if (b.status !== 'paused') throw mailErrors.not_editable();
  await ctx.db.update('mail_broadcasts', id, { status: 'sending', next_run_at: null, lock_until: null, heartbeat_at: now, last_error: '', updated_at: now });
  await kick(ctx.env, { orgId: ctx.org.id, broadcastId: id });
  return getBroadcast(ctx, id);
}

export interface BatchResult {
  state: 'skipped' | 'working' | 'done' | 'backoff' | 'paused';
  sent: number;
}

interface Outcome {
  id: string;
  status: Delivery['status'];
  reason: string;
  sentAt: number | null;
}

/** One queue job: send up to `BATCH_SIZE` messages and line up the next job. Always safe to run twice. */
export async function runBatch(env: Env, payload: BatchPayload, now = Date.now(), deps: { sender?: Sender; size?: number } = {}): Promise<BatchResult> {
  const sender = deps.sender ?? coreSender(env);
  const size = deps.size ?? BATCH_SIZE;
  const db = env.DB;
  const locked = await db
    .prepare(
      `UPDATE mail_broadcasts SET lock_until = ?3, heartbeat_at = ?4
       WHERE org_id = ?1 AND id = ?2 AND status = 'sending' AND (lock_until IS NULL OR lock_until < ?4) AND (next_run_at IS NULL OR next_run_at <= ?4)
       RETURNING *`,
    )
    .bind(payload.orgId, payload.broadcastId, now + LOCK_MS, now)
    .first<Broadcast>();
  if (!locked) return { state: 'skipped', sent: 0 };
  const ctx = ctxOf(env, payload.orgId);
  const unlock = (extra = '') => db.prepare(`UPDATE mail_broadcasts SET lock_until = NULL, heartbeat_at = ?3 ${extra} WHERE org_id = ?1 AND id = ?2`);

  const claimed = await db
    .prepare(
      `UPDATE mail_deliveries SET status = 'sending', claimed_at = ?3, attempts = attempts + 1
       WHERE id IN (SELECT id FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2 AND (status = 'queued' OR (status = 'sending' AND claimed_at < ?4)) ORDER BY created_at, id LIMIT ?5)
       RETURNING *`,
    )
    .bind(payload.orgId, payload.broadcastId, now, now - CLAIM_LEASE_MS, size)
    .all<Delivery>();
  const rows = claimed.results;

  if (rows.length === 0) {
    const open = await db.prepare("SELECT COUNT(*) AS n FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2 AND status IN ('queued', 'sending')").bind(payload.orgId, payload.broadcastId).first<{ n: number }>();
    if ((open?.n ?? 0) > 0) {
      // Someone else's claim is still fresh. Look again after the lease.
      await unlock().bind(payload.orgId, payload.broadcastId, now).run();
      await kick(env, payload, 30);
      return { state: 'working', sent: 0 };
    }
    await finish(ctx, locked, now);
    return { state: 'done', sent: 0 };
  }

  const [list, brand, settings, base] = await Promise.all([
    ctx.db.get<List>('mail_lists', locked.list_id),
    resolveBrand(env, payload.orgId),
    getMailSettings(env, payload.orgId),
    linkBase(env, payload.orgId),
  ]);
  const ids = rows.map((r) => r.subscriber_id);
  const marks = ids.map(() => '?').join(',');
  const [subs, members, supp, links] = await Promise.all([
    ctx.db.all<Subscriber>(`SELECT * FROM mail_subscribers WHERE org_id = :org AND id IN (${marks})`, ...ids),
    ctx.db.all<{ subscriber_id: string }>(`SELECT subscriber_id FROM mail_memberships WHERE org_id = :org AND list_id = ? AND status = 'active' AND subscriber_id IN (${marks})`, locked.list_id, ...ids),
    ctx.db.all<{ email: string }>(`SELECT email FROM mail_suppressions WHERE org_id = :org AND list_id IN ('', ?) AND email IN (${rows.map(() => '?').join(',')})`, locked.list_id, ...rows.map((r) => r.email)),
    locked.track_clicks ? ctx.db.all<{ id: string; url: string }>('SELECT id, url FROM mail_links WHERE org_id = :org AND broadcast_id = ?', locked.id) : Promise.resolve([]),
  ]);
  const subById = new Map(subs.map((s) => [s.id, s]));
  const active = new Set(members.map((m) => m.subscriber_id));
  const blocked = new Set(supp.map((s) => s.email));
  const linkMap = new Map(links.map((l) => [l.url, l.id]));

  const outcomes: Outcome[] = [];
  let state: BatchResult['state'] = 'working';
  let sent = 0;
  let pauseReason = '';
  try {
    for (const row of rows) {
      const sub = subById.get(row.subscriber_id);
      if (!list || !sub) outcomes.push({ id: row.id, status: 'skipped', reason: 'removed', sentAt: null });
      else if (!active.has(sub.id)) outcomes.push({ id: row.id, status: 'skipped', reason: 'unsubscribed', sentAt: null });
      else if (blocked.has(sub.email)) outcomes.push({ id: row.id, status: 'skipped', reason: 'suppressed', sentAt: null });
      else {
        const message = await composeMessage({
          env,
          list,
          sub,
          content: locked,
          kind: 'mail.broadcast',
          scope: locked.id,
          base,
          brand,
          postalAddress: settings.postalAddress,
          links: linkMap,
          deliveryId: row.id,
          trackOpens: locked.track_opens === 1,
          ...(locked.in_archive && locked.archive_slug && list.archive_public ? { viewUrl: `${base}/n/${list.slug}/archive/${locked.archive_slug}` } : {}),
        });
        if (await sender.alreadySent(payload.orgId, sub.email, message.template)) {
          outcomes.push({ id: row.id, status: 'sent', reason: 'resumed', sentAt: now });
          sent++;
          continue;
        }
        const result = await sender.send(message);
        if (result.ok) {
          outcomes.push({ id: row.id, status: 'sent', reason: '', sentAt: now });
          sent++;
        } else if (result.kind === 'suppressed') outcomes.push({ id: row.id, status: 'skipped', reason: 'suppressed', sentAt: null });
        else if (result.kind === 'capped') {
          outcomes.push({ id: row.id, status: 'queued', reason: '', sentAt: null });
          state = 'backoff';
        } else if (result.kind === 'not_configured') {
          outcomes.push({ id: row.id, status: 'queued', reason: '', sentAt: null });
          state = 'paused';
          pauseReason = result.error;
        } else outcomes.push({ id: row.id, status: row.attempts >= MAX_DELIVERY_ATTEMPTS ? 'failed' : 'queued', reason: result.error.slice(0, 200), sentAt: null });
        if (state === 'backoff' || state === 'paused') {
          // Return the rest of this batch untouched.
          for (const rest of rows.slice(rows.indexOf(row) + 1)) outcomes.push({ id: rest.id, status: 'queued', reason: '', sentAt: null });
          break;
        }
      }
    }
  } finally {
    // Whatever happened, write down what we know. A throw leaves the rest claimed; the lease frees them.
    if (outcomes.length) {
      const stmt = db.prepare(
        `UPDATE mail_deliveries SET status = ?2, reason = ?3, sent_at = COALESCE(?4, sent_at), claimed_at = CASE WHEN ?2 = 'queued' THEN NULL ELSE claimed_at END,
           attempts = CASE WHEN ?2 = 'queued' AND ?3 = '' THEN MAX(attempts - 1, 0) ELSE attempts END WHERE id = ?1`,
      );
      await db.batch(outcomes.map((o) => stmt.bind(o.id, o.status, o.reason, o.sentAt)));
    }
  }

  const counts = `sent_count = (SELECT COUNT(*) FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2 AND status = 'sent'),
    failed_count = (SELECT COUNT(*) FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2 AND status = 'failed'),
    skipped_count = (SELECT COUNT(*) FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2 AND status = 'skipped')`;
  if (state === 'paused') {
    await db
      .prepare(`UPDATE mail_broadcasts SET status = 'paused', lock_until = NULL, heartbeat_at = ?3, last_error = ?4, ${counts} WHERE org_id = ?1 AND id = ?2`)
      .bind(payload.orgId, payload.broadcastId, now, pauseReason.slice(0, 200))
      .run();
    return { state, sent };
  }
  if (state === 'backoff') {
    await db
      .prepare(`UPDATE mail_broadcasts SET lock_until = NULL, heartbeat_at = ?3, next_run_at = ?4, last_error = 'Waiting: the hourly email limit was reached.', ${counts} WHERE org_id = ?1 AND id = ?2`)
      .bind(payload.orgId, payload.broadcastId, now, now + CAP_BACKOFF_MS)
      .run();
    await kick(env, payload, Math.ceil(CAP_BACKOFF_MS / 1000));
    return { state, sent };
  }
  await db
    .prepare(`UPDATE mail_broadcasts SET lock_until = NULL, heartbeat_at = ?3, last_error = '', ${counts} WHERE org_id = ?1 AND id = ?2`)
    .bind(payload.orgId, payload.broadcastId, now)
    .run();
  await kick(env, payload, BATCH_DELAY_S);
  return { state: 'working', sent };
}

async function finish(ctx: Ctx, b: Broadcast, now: number): Promise<void> {
  const row = await ctx.db.first<{ sent: number; failed: number; skipped: number; total: number }>(
    `SELECT SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed, SUM(status = 'skipped') AS skipped, COUNT(*) AS total FROM mail_deliveries WHERE org_id = :org AND broadcast_id = ?`,
    b.id,
  );
  const sent = row?.sent ?? 0;
  const failed = row?.failed ?? 0;
  const allFailed = sent === 0 && failed > 0;
  await ctx.db.run(
    `UPDATE mail_broadcasts SET status = ?, finished_at = ?, lock_until = NULL, heartbeat_at = ?, sent_count = ?, failed_count = ?, skipped_count = ?, total = ?, last_error = ?, updated_at = ?
     WHERE org_id = :org AND id = ?`,
    allFailed ? 'failed' : 'sent',
    now,
    now,
    sent,
    failed,
    row?.skipped ?? 0,
    row?.total ?? 0,
    allFailed ? 'Every message failed to send.' : failed > 0 ? `${failed} could not be sent.` : '',
    now,
    b.id,
  );
  await emit(ctx.env, {
    orgId: ctx.org.id,
    module: 'mail',
    name: allFailed ? 'broadcast.failed' : 'broadcast.sent',
    subject: b.id,
    data: { subject: b.subject, sent, failed, skipped: row?.skipped ?? 0 },
    count: sent,
    at: now,
  });
}

/** Every minute: restart stalled sends and start scheduled ones. Touches at most a few broadcasts per run. */
export async function watchdog(env: Env, now = Date.now()): Promise<{ restarted: number; started: number; failed: number }> {
  const stalled = await env.DB.prepare(
    `SELECT id, org_id FROM mail_broadcasts WHERE status = 'sending' AND (lock_until IS NULL OR lock_until < ?1) AND (heartbeat_at IS NULL OR heartbeat_at < ?2) AND (next_run_at IS NULL OR next_run_at <= ?1) LIMIT 5`,
  )
    .bind(now, now - STALL_MS)
    .all<{ id: string; org_id: string }>();
  for (const s of stalled.results) await kick(env, { orgId: s.org_id, broadcastId: s.id });

  const due = await env.DB.prepare("SELECT id, org_id FROM mail_broadcasts WHERE status = 'scheduled' AND scheduled_at <= ?1 ORDER BY scheduled_at LIMIT 3").bind(now).all<{ id: string; org_id: string }>();
  let started = 0;
  let failed = 0;
  for (const d of due.results) {
    const ctx = ctxOf(env, d.org_id);
    try {
      await startBroadcast(ctx, d.id, now);
      started++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : 'It could not start.';
      await ctx.db.update('mail_broadcasts', d.id, { status: 'failed', last_error: message.slice(0, 200), finished_at: now, updated_at: now });
      await emit(env, { orgId: d.org_id, module: 'mail', name: 'broadcast.failed', subject: d.id, data: { error: message.slice(0, 200) }, at: now });
    }
  }
  return { restarted: stalled.results.length, started, failed };
}
