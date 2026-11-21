/**
 * Usage events. `emit()` does three things:
 * 1. adds to the day's total (for charts and Overview numbers),
 * 2. writes a line to the short recent-events log (for activity feeds),
 * 3. hands the event to any module that subscribed to it, through the jobs queue.
 *
 * On hot public paths (redirects, page views) call it inside `c.executionCtx.waitUntil(...)`.
 */
import type { Env } from '../env';
import { newId, parseJson } from './db';
import { enqueue, registerCoreJob, registerCoreSchedule } from './jobs';
import type { AppEvent } from './module';
import { allModules, moduleContext, moduleState } from './registry';

const RECENT_KEEP_DAYS = 30;

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function hasSubscribers(fullName: string): boolean {
  return allModules().some((m) => m.events?.on?.[fullName]);
}

export async function emit(env: Env, event: AppEvent): Promise<void> {
  const at = event.at ?? Date.now();
  const count = event.count ?? 1;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO event_counts (org_id, module, name, day, count) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT (org_id, module, name, day) DO UPDATE SET count = count + excluded.count`,
    ).bind(event.orgId, event.module, event.name, dayOf(at), count),
    env.DB.prepare('INSERT INTO events_recent (id, org_id, module, name, subject, data, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(
      newId('evt', at),
      event.orgId,
      event.module,
      event.name,
      event.subject ?? null,
      event.data ? JSON.stringify(event.data) : null,
      at,
    ),
  ]);
  if (hasSubscribers(`${event.module}.${event.name}`)) {
    await enqueue(env, 'core.event', { ...event, at, count });
  }
}

/** Deliver one event to every subscribed module the workspace has turned on. */
export async function dispatchEvent(env: Env, event: AppEvent): Promise<void> {
  const full = `${event.module}.${event.name}`;
  for (const m of allModules()) {
    const handler = m.events?.on?.[full];
    if (!handler) continue;
    if (!(await moduleState(env, event.orgId, m.id)).enabled) continue;
    await handler(await moduleContext(env, event.orgId), event);
  }
}

registerCoreJob('event', (env, payload) => dispatchEvent(env, payload as AppEvent));

export interface DayCount {
  /** 'YYYY-MM-DD' (UTC). */
  day: string;
  count: number;
}

/**
 * Daily totals for the last `days` days, oldest first, with zeros for quiet days.
 * Leave `name` out to add up every event of the module.
 */
export async function eventCounts(
  env: Env,
  orgId: string,
  opts: { module: string; name?: string; days?: number; now?: number },
): Promise<DayCount[]> {
  const days = Math.min(Math.max(1, opts.days ?? 30), 366);
  const now = opts.now ?? Date.now();
  const from = dayOf(now - (days - 1) * 86_400_000);
  const { results } = await env.DB.prepare(
    `SELECT day, SUM(count) AS count FROM event_counts
     WHERE org_id = ?1 AND module = ?2 AND (?3 IS NULL OR name = ?3) AND day >= ?4
     GROUP BY day`,
  )
    .bind(orgId, opts.module, opts.name ?? null, from)
    .all<DayCount>();
  const byDay = new Map(results.map((r) => [r.day, r.count]));
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * 86_400_000);
    out.push({ day, count: byDay.get(day) ?? 0 });
  }
  return out;
}

export async function eventTotal(env: Env, orgId: string, opts: { module: string; name?: string; days?: number; now?: number }): Promise<number> {
  return (await eventCounts(env, orgId, opts)).reduce((sum, d) => sum + d.count, 0);
}

export interface RecentEvent {
  id: string;
  module: string;
  name: string;
  subject: string | null;
  data: Record<string, unknown>;
  at: number;
}

export async function recentEvents(env: Env, orgId: string, opts: { module?: string; limit?: number } = {}): Promise<RecentEvent[]> {
  const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
  const { results } = await env.DB.prepare(
    `SELECT id, module, name, subject, data, at FROM events_recent
     WHERE org_id = ?1 AND (?2 IS NULL OR module = ?2) ORDER BY at DESC, id DESC LIMIT ${limit}`,
  )
    .bind(orgId, opts.module ?? null)
    .all<{ id: string; module: string; name: string; subject: string | null; data: string | null; at: number }>();
  return results.map((r) => ({ ...r, data: parseJson<Record<string, unknown>>(r.data, {}) }));
}

registerCoreSchedule({
  name: 'trim-recent-events',
  every: 'day',
  run: async (env, at) => {
    await env.DB.prepare('DELETE FROM events_recent WHERE at < ?1')
      .bind(at.getTime() - RECENT_KEEP_DAYS * 86_400_000)
      .run();
  },
});
