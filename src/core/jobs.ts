/**
 * Background jobs (Cloudflare Queues) and schedules (Cron).
 *
 * - `enqueue(env, 'links.rollup', payload)` runs `jobs.rollup` of the `links` module later, with retries.
 * - A module's `schedules` run on the minute, 5 minutes, hour or day (UTC).
 * - Core services add their own with `registerCoreJob` and `registerCoreSchedule`.
 */
import type { Env, JobMessage } from '../env';
import { errors } from './errors';
import { newId, parseJson } from './db';
import type { JobHandler, Schedule } from './module';
import { allModules, getModule } from './registry';

const coreJobs = new Map<string, JobHandler>();
const coreSchedules: Schedule[] = [];

/** Register a job named `core.<name>`. */
export function registerCoreJob(name: string, handler: JobHandler): void {
  coreJobs.set(`core.${name}`, handler);
}

export function registerCoreSchedule(schedule: Schedule): void {
  if (!coreSchedules.some((s) => s.name === schedule.name)) coreSchedules.push(schedule);
}

/** Put a job on the queue. `name` is `<moduleId>.<job>` or `core.<job>`. */
export async function enqueue(env: Env, name: string, payload: unknown, opts: { delaySeconds?: number } = {}): Promise<void> {
  if (!findHandler(name)) throw new Error(`No job handler is registered for "${name}"`);
  await env.JOBS.send({ name, payload }, opts.delaySeconds ? { delaySeconds: opts.delaySeconds } : undefined);
}

function findHandler(name: string): JobHandler | undefined {
  const core = coreJobs.get(name);
  if (core) return core;
  const dot = name.indexOf('.');
  if (dot < 1) return undefined;
  return getModule(name.slice(0, dot))?.jobs?.[name.slice(dot + 1)];
}

/** Run one job now. Throws when the handler throws, so the queue can retry it. */
export async function runJob(env: Env, msg: JobMessage, attempt = 1): Promise<void> {
  const handler = findHandler(msg.name);
  if (!handler) {
    console.error(`[jobs] no handler for ${msg.name}; dropping`);
    return;
  }
  await handler(env, msg.payload, { attempt });
}

/**
 * Deliveries a job gets before it is logged as failed. Keep it below the queue's `max_retries` + 1
 * (see wrangler.jsonc) so we record the failure ourselves instead of the queue dropping it silently.
 */
export const MAX_JOB_ATTEMPTS = 5;

/** Seconds to wait before attempt `attempt + 1`: 30 s, 1 min, 2 min, 4 min, capped at 15 min. */
export function retryDelaySeconds(attempt: number): number {
  return Math.min(30 * 2 ** Math.max(0, attempt - 1), 900);
}

/** Queue consumer. Each message is acknowledged or retried on its own, with a growing delay. */
export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runJob(env, message.body, message.attempts);
      message.ack();
    } catch (err) {
      console.error(`[jobs] ${message.body?.name} failed (attempt ${message.attempts})`, err);
      if (message.attempts >= MAX_JOB_ATTEMPTS) {
        try {
          await recordJobFailure(env, message.body, err, message.attempts);
        } catch (logErr) {
          console.error('[jobs] could not write the failure log', logErr);
        }
        message.ack();
      } else {
        message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      }
    }
  }
}

/** Jobs whose payload holds secrets (codes, links). Their failures are logged without a payload to retry. */
const NO_PAYLOAD = new Set<string>();

/** Mark a job as one whose payload must never be stored, even for retry. */
export function markJobSensitive(name: string): void {
  NO_PAYLOAD.add(name);
}

const SECRET_KEY = /code|token|secret|password|passwd|link|url|body|html|text|key|authorization|cookie|email|address|^to$/i;
const MAX_STORED_PAYLOAD = 8_000;

/** A short, readable copy of a payload with secret-looking values hidden. */
export function redactPayload(payload: unknown): string {
  const seen = (value: unknown, depth: number): unknown => {
    if (depth > 3) return '…';
    if (Array.isArray(value)) return value.slice(0, 5).map((v) => seen(v, depth + 1));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .slice(0, 20)
          .map(([k, v]) => [k, SECRET_KEY.test(k) ? '[hidden]' : seen(v, depth + 1)]),
      );
    }
    if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 60)}…` : value;
    return value;
  };
  const text = JSON.stringify(seen(payload, 0)) ?? 'null';
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Write a job that ran out of retries to `job_failures`. Called by the queue consumer. */
export async function recordJobFailure(env: Env, msg: JobMessage, err: unknown, attempts: number): Promise<void> {
  const raw = JSON.stringify(msg.payload ?? null);
  const keep = !NO_PAYLOAD.has(msg.name) && raw.length <= MAX_STORED_PAYLOAD;
  const orgId = (msg.payload as { orgId?: unknown } | null)?.orgId;
  const error = err instanceof Error ? err.message : String(err);
  await env.DB.prepare(
    `INSERT INTO job_failures (id, org_id, name, payload_size, payload_preview, payload, error, attempts, failed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      newId('jf'),
      typeof orgId === 'string' ? orgId : '',
      msg.name,
      raw.length,
      NO_PAYLOAD.has(msg.name) ? '[hidden]' : redactPayload(msg.payload),
      keep ? raw : null,
      error.slice(0, 500),
      attempts,
      Date.now(),
    )
    .run();
}

export interface JobFailure {
  id: string;
  name: string;
  orgId: string;
  payloadSize: number;
  payloadPreview: string;
  error: string;
  attempts: number;
  failedAt: number;
  retriedAt: number | null;
  /** False when the payload was too big or too sensitive to keep. */
  canRetry: boolean;
}

/** Latest failed jobs, newest first. For the install owner. */
export async function listJobFailures(env: Env, opts: { limit?: number; before?: number } = {}): Promise<JobFailure[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, org_id, name, payload_size, payload_preview, payload IS NOT NULL AS can_retry, error, attempts, failed_at, retried_at
     FROM job_failures WHERE (?1 IS NULL OR failed_at < ?1) ORDER BY failed_at DESC, id DESC LIMIT ${limit}`,
  )
    .bind(opts.before ?? null)
    .all<{
      id: string;
      org_id: string;
      name: string;
      payload_size: number;
      payload_preview: string;
      can_retry: number;
      error: string;
      attempts: number;
      failed_at: number;
      retried_at: number | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    orgId: r.org_id,
    payloadSize: r.payload_size,
    payloadPreview: r.payload_preview,
    error: r.error,
    attempts: r.attempts,
    failedAt: r.failed_at,
    retriedAt: r.retried_at,
    canRetry: r.can_retry === 1,
  }));
}

/** Put a failed job back on the queue with a fresh set of attempts. */
export async function retryJobFailure(env: Env, id: string): Promise<void> {
  const row = await env.DB.prepare('SELECT name, payload FROM job_failures WHERE id = ?1').bind(id).first<{ name: string; payload: string | null }>();
  if (!row) throw errors.not_found('That failed job is gone. It may already have been cleared.');
  if (row.payload === null) throw errors.conflict('This job’s details were too large or too private to keep, so it can’t be retried from here.');
  // Claim the row first, so a double click or a replayed form can't queue the job twice.
  const claim = await env.DB.prepare('UPDATE job_failures SET retried_at = ?2 WHERE id = ?1 AND retried_at IS NULL').bind(id, Date.now()).run();
  if (!claim.meta.changes) throw errors.conflict('This job was already put back on the queue.');
  try {
    await enqueue(env, row.name, parseJson<unknown>(row.payload, null));
  } catch (err) {
    await env.DB.prepare('UPDATE job_failures SET retried_at = NULL WHERE id = ?1').bind(id).run();
    throw err;
  }
}

/**
 * Run `fn` at most once per `key` within `ttlSeconds`, even when a job is delivered twice. If `fn`
 * throws, the key is released so the retry can run it again. The claim is one atomic D1 statement.
 */
export async function once<T>(env: Env, key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `INSERT INTO once_keys (key, expires_at) VALUES (?1, ?2)
     ON CONFLICT (key) DO UPDATE SET expires_at = excluded.expires_at WHERE once_keys.expires_at <= ?3
     RETURNING key`,
  )
    .bind(key, now + ttlSeconds * 1000, now)
    .first<{ key: string }>();
  if (!claimed) return { ran: false };
  try {
    return { ran: true, value: await fn() };
  } catch (err) {
    await env.DB.prepare('DELETE FROM once_keys WHERE key = ?1').bind(key).run();
    throw err;
  }
}

/**
 * Delete expired `once` keys and failure rows older than `keepDays`. Also delete failures that
 * name a workspace which no longer exists: a job that was already on the queue when its workspace
 * was deleted fails afterwards, and that record should not outlive the workspace by a month.
 * Run by the daily housekeeping.
 */
export async function cleanupJobs(env: Env, now = Date.now(), keepDays = 30): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM once_keys WHERE expires_at <= ?1').bind(now),
    env.DB.prepare('DELETE FROM job_failures WHERE failed_at < ?1').bind(now - keepDays * 86_400_000),
    env.DB.prepare(`DELETE FROM job_failures WHERE org_id <> '' AND org_id NOT IN (SELECT "id" FROM "organization")`),
  ]);
}

function isDue(every: Schedule['every'], at: Date): boolean {
  const minute = at.getUTCMinutes();
  const hour = at.getUTCHours();
  if (every === 'minute') return true;
  if (every === '5min') return minute % 5 === 0;
  if (every === 'hour') return minute === 0;
  return minute === 0 && hour === 0;
}

/** Cron entry point, called every minute. One failing schedule does not stop the others. */
export async function runSchedules(env: Env, at: Date): Promise<{ ran: string[]; failed: string[] }> {
  const due: { name: string; run: Schedule['run'] }[] = [];
  for (const s of coreSchedules) if (isDue(s.every, at)) due.push({ name: `core.${s.name}`, run: s.run });
  for (const m of allModules()) {
    for (const s of m.schedules ?? []) if (isDue(s.every, at)) due.push({ name: `${m.id}.${s.name}`, run: s.run });
  }
  const results = await Promise.allSettled(due.map((d) => d.run(env, at)));
  const ran: string[] = [];
  const failed: string[] = [];
  results.forEach((r, i) => {
    const name = due[i]!.name;
    if (r.status === 'fulfilled') ran.push(name);
    else {
      failed.push(name);
      console.error(`[schedules] ${name} failed`, r.reason);
    }
  });
  return { ran, failed };
}
