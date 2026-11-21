/**
 * Background jobs (Cloudflare Queues) and schedules (Cron).
 *
 * - `enqueue(env, 'links.rollup', payload)` runs `jobs.rollup` of the `links` module later, with retries.
 * - A module's `schedules` run on the minute, 5 minutes, hour or day (UTC).
 * - Core services add their own with `registerCoreJob` and `registerCoreSchedule`.
 */
import type { Env, JobMessage } from '../env';
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

/** Queue consumer. Each message is acknowledged or retried on its own, with a growing delay. */
export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await runJob(env, message.body, message.attempts);
      message.ack();
    } catch (err) {
      console.error(`[jobs] ${message.body?.name} failed (attempt ${message.attempts})`, err);
      message.retry({ delaySeconds: Math.min(30 * 2 ** (message.attempts - 1), 900) });
    }
  }
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
