/** History: minute rows roll up into hours, hours into days. Readers combine the finished rollups with the partial hour. */
import type { Env } from '../../env';
import { getModuleSettings } from '../../core/registry';
import { DAY, HOUR, MINUTE, dayKey, dayStart, hourOf, minuteOf } from './time';
import { DEFAULT_SETTINGS, type MonitorSettings } from './schema';

export interface Bucket {
  up: number;
  down: number;
  avg: number | null;
  p95: number | null;
}

/** One stored result: [monitorId, ok, ms, code, flags, error]. */
export type Result = [string, number, number, number, string, string];

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

function parseResults(json: string): Result[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as Result[]) : [];
  } catch {
    return [];
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
}

interface Acc {
  org: string;
  up: number;
  down: number;
  ms: number[];
}

/** Fold stored minute rows into per-monitor buckets. Maintenance minutes ('m') count as neither up nor down. */
export function foldMinutes(rows: { org_id: string; results: string }[]): Map<string, Acc> {
  const acc = new Map<string, Acc>();
  for (const row of rows) {
    for (const r of parseResults(row.results)) {
      if (!Array.isArray(r) || r.length < 5) continue;
      const [id, ok, ms, , flags] = r;
      if (typeof flags === 'string' && flags.includes('m')) continue;
      let a = acc.get(id);
      if (!a) acc.set(id, (a = { org: row.org_id, up: 0, down: 0, ms: [] }));
      if (ok) {
        a.up++;
        if (ms > 0) a.ms.push(ms);
      } else a.down++;
    }
  }
  return acc;
}

function bucketOf(a: Acc): Bucket {
  const sorted = [...a.ms].sort((x, y) => x - y);
  return {
    up: a.up,
    down: a.down,
    avg: sorted.length ? Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length) : null,
    p95: percentile(sorted, 0.95),
  };
}

async function writeBatches(env: Env, stmts: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < stmts.length; i += 40) await env.DB.batch(stmts.slice(i, i + 40));
}

/** Roll one finished hour (start in ms, aligned) up for every workspace. Safe to run again. */
export async function rollupHour(env: Env, hour: number): Promise<number> {
  const { results } = await env.DB.prepare(`SELECT org_id, results FROM mon_minutes WHERE minute >= ?1 AND minute < ?2`).bind(hour, hour + HOUR).all<{ org_id: string; results: string }>();
  const acc = foldMinutes(results);
  const stmts: D1PreparedStatement[] = [];
  for (const [monitorId, a] of acc) {
    const b = bucketOf(a);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO mon_hourly (org_id, monitor_id, hour, up, down, avg_ms, p95_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT (monitor_id, hour) DO UPDATE SET up = excluded.up, down = excluded.down, avg_ms = excluded.avg_ms, p95_ms = excluded.p95_ms`,
      ).bind(a.org, monitorId, hour, b.up, b.down, b.avg, b.p95),
    );
  }
  await writeBatches(env, stmts);
  return acc.size;
}

/** Roll one finished UTC day up from the hourly rows. */
export async function rollupDay(env: Env, day: string): Promise<number> {
  const from = dayStart(day);
  const { results } = await env.DB.prepare(
    `SELECT org_id, monitor_id, SUM(up) AS up, SUM(down) AS down,
            SUM(avg_ms * (up + down)) * 1.0 / NULLIF(SUM(CASE WHEN avg_ms IS NULL THEN 0 ELSE up + down END), 0) AS avg_ms,
            MAX(p95_ms) AS p95_ms
     FROM mon_hourly WHERE hour >= ?1 AND hour < ?2 GROUP BY org_id, monitor_id`,
  )
    .bind(from, from + DAY)
    .all<{ org_id: string; monitor_id: string; up: number; down: number; avg_ms: number | null; p95_ms: number | null }>();
  const stmts = results.map((r) =>
    env.DB.prepare(
      `INSERT INTO mon_daily (org_id, monitor_id, day, up, down, avg_ms, p95_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (monitor_id, day) DO UPDATE SET up = excluded.up, down = excluded.down, avg_ms = excluded.avg_ms, p95_ms = excluded.p95_ms`,
    ).bind(r.org_id, r.monitor_id, day, num(r.up), num(r.down), r.avg_ms === null ? null : Math.round(r.avg_ms), r.p95_ms),
  );
  await writeBatches(env, stmts);
  return results.length;
}

/** Hourly schedule: roll the hour that just ended; at midnight also the day that just ended. Catches up one missed hour. */
export async function rollupSchedule(env: Env, at: Date): Promise<void> {
  const now = at.getTime();
  const thisHour = hourOf(now);
  await rollupHour(env, thisHour - 2 * HOUR);
  await rollupHour(env, thisHour - HOUR);
  // The day that just ended is rolled in the first two hours of the new day (the second run is a catch-up).
  if (thisHour - dayStart(dayKey(now)) < 2 * HOUR) await rollupDay(env, dayKey(now - DAY));
}

/** Daily: drop what is past its keep time. Minute rows go after 2 days (hours hold the history). */
export async function pruneSchedule(env: Env, at: Date): Promise<void> {
  const now = at.getTime();
  const orgs = (await env.DB.prepare(`SELECT DISTINCT org_id FROM mon_monitors`).all<{ org_id: string }>()).results;
  let hourlyDays = DEFAULT_SETTINGS.keepHourlyDays;
  let dailyDays = DEFAULT_SETTINGS.keepDailyDays;
  for (const o of orgs) {
    const s = await getModuleSettings<MonitorSettings>(env, o.org_id, 'monitor', DEFAULT_SETTINGS);
    hourlyDays = Math.max(hourlyDays, s.keepHourlyDays);
    dailyDays = Math.max(dailyDays, s.keepDailyDays);
  }
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM mon_minutes WHERE minute < ?1`).bind(now - 2 * DAY),
    env.DB.prepare(`DELETE FROM mon_hourly WHERE hour < ?1`).bind(now - hourlyDays * DAY),
    env.DB.prepare(`DELETE FROM mon_daily WHERE day < ?1`).bind(dayKey(now - dailyDays * DAY)),
    env.DB.prepare(`DELETE FROM mon_failures WHERE at < ?1`).bind(now - 30 * DAY),
    env.DB.prepare(`DELETE FROM mon_alerts WHERE at < ?1`).bind(now - 30 * DAY),
  ]);
}

/** Add two buckets (weighted averages, the larger p95). */
function addBuckets(a: Bucket | undefined, b: Bucket): Bucket {
  if (!a) return { ...b };
  const na = a.up + a.down;
  const nb = b.up + b.down;
  const avg = a.avg === null ? b.avg : b.avg === null ? a.avg : Math.round((a.avg * na + b.avg * nb) / Math.max(1, na + nb));
  return { up: a.up + b.up, down: a.down + b.down, avg, p95: Math.max(a.p95 ?? 0, b.p95 ?? 0) || null };
}

/** The not-yet-rolled part of the current hour, per monitor. */
async function currentHour(env: Env, orgId: string, at: number): Promise<Map<string, Bucket>> {
  const from = hourOf(at);
  const { results } = await env.DB.prepare(`SELECT org_id, results FROM mon_minutes WHERE org_id = ?1 AND minute >= ?2 AND minute <= ?3`).bind(orgId, from, minuteOf(at)).all<{ org_id: string; results: string }>();
  const out = new Map<string, Bucket>();
  for (const [id, a] of foldMinutes(results)) out.set(id, bucketOf(a));
  return out;
}

/** Daily buckets for the last `days` days including today (oldest first), per monitor. Today is built from hours plus the live hour. */
export async function dailySeries(env: Env, orgId: string, monitorIds: string[], days: number, at = Date.now()): Promise<Map<string, { day: string; b: Bucket | null }[]>> {
  const out = new Map<string, { day: string; b: Bucket | null }[]>();
  if (monitorIds.length === 0) return out;
  const today = dayKey(at);
  const keys: string[] = [];
  for (let i = days - 1; i >= 0; i--) keys.push(dayKey(at - i * DAY));
  const qs = monitorIds.map(() => '?').join(',');
  const finished = (
    await env.DB.prepare(`SELECT monitor_id, day, up, down, avg_ms, p95_ms FROM mon_daily WHERE org_id = ?1 AND day >= ?2 AND day < ?3 AND monitor_id IN (${qs})`)
      .bind(orgId, keys[0], today, ...monitorIds)
      .all<{ monitor_id: string; day: string; up: number; down: number; avg_ms: number | null; p95_ms: number | null }>()
  ).results;
  const hours = (
    await env.DB.prepare(`SELECT monitor_id, hour, up, down, avg_ms, p95_ms FROM mon_hourly WHERE org_id = ?1 AND hour >= ?2 AND monitor_id IN (${qs})`)
      .bind(orgId, dayStart(today), ...monitorIds)
      .all<{ monitor_id: string; hour: number; up: number; down: number; avg_ms: number | null; p95_ms: number | null }>()
  ).results;
  const live = await currentHour(env, orgId, at);
  const byDay = new Map<string, Bucket>();
  for (const r of finished) byDay.set(`${r.monitor_id}|${r.day}`, { up: r.up, down: r.down, avg: r.avg_ms, p95: r.p95_ms });
  for (const r of hours) {
    const k = `${r.monitor_id}|${today}`;
    byDay.set(k, addBuckets(byDay.get(k), { up: r.up, down: r.down, avg: r.avg_ms, p95: r.p95_ms }));
  }
  for (const [id, b] of live) {
    const k = `${id}|${today}`;
    byDay.set(k, addBuckets(byDay.get(k), b));
  }
  for (const id of monitorIds) {
    out.set(
      id,
      keys.map((day) => ({ day, b: byDay.get(`${id}|${day}`) ?? null })),
    );
  }
  return out;
}

/** Hourly buckets for the last `hours` hours (oldest first) for one monitor, with the live hour last. */
export async function hourlySeries(env: Env, orgId: string, monitorId: string, hours: number, at = Date.now()): Promise<{ hour: number; b: Bucket | null }[]> {
  const nowHour = hourOf(at);
  const from = nowHour - (hours - 1) * HOUR;
  const rows = (
    await env.DB.prepare(`SELECT hour, up, down, avg_ms, p95_ms FROM mon_hourly WHERE org_id = ?1 AND monitor_id = ?2 AND hour >= ?3`)
      .bind(orgId, monitorId, from)
      .all<{ hour: number; up: number; down: number; avg_ms: number | null; p95_ms: number | null }>()
  ).results;
  const map = new Map<number, Bucket>(rows.map((r) => [r.hour, { up: r.up, down: r.down, avg: r.avg_ms, p95: r.p95_ms }]));
  const live = (await currentHour(env, orgId, at)).get(monitorId);
  if (live) map.set(nowHour, live);
  const out: { hour: number; b: Bucket | null }[] = [];
  for (let h = from; h <= nowHour; h += HOUR) out.push({ hour: h, b: map.get(h) ?? null });
  return out;
}

export interface MinutePoint {
  minute: number;
  ok: boolean;
  ms: number;
  code: number | null;
  maintenance: boolean;
  error: string;
}

/** The most recent results for one monitor, newest first. Reads at most `minutes` stored minute rows. */
export async function recentResults(env: Env, orgId: string, monitorId: string, minutes = 60, at = Date.now()): Promise<MinutePoint[]> {
  const { results } = await env.DB.prepare(`SELECT minute, results FROM mon_minutes WHERE org_id = ?1 AND minute > ?2 ORDER BY minute DESC LIMIT ?3`)
    .bind(orgId, minuteOf(at) - minutes * MINUTE, minutes * 2)
    .all<{ minute: number; results: string }>();
  const out: MinutePoint[] = [];
  for (const row of results) {
    for (const r of parseResults(row.results)) {
      if (r[0] !== monitorId) continue;
      out.push({ minute: row.minute, ok: !!r[1], ms: num(r[2]), code: r[3] ? num(r[3]) : null, maintenance: String(r[4] ?? '').includes('m'), error: String(r[5] ?? '') });
    }
  }
  return out.sort((a, b) => b.minute - a.minute);
}

export interface Summary {
  up: number;
  down: number;
  uptimePct: number | null;
  avgMs: number | null;
  p95Ms: number | null;
}

/** Combine buckets into one uptime figure. `null` when nothing was measured. */
export function summarize(buckets: (Bucket | null)[]): Summary {
  let acc: Bucket | undefined;
  for (const b of buckets) if (b) acc = addBuckets(acc, b);
  if (!acc || acc.up + acc.down === 0) return { up: 0, down: 0, uptimePct: null, avgMs: null, p95Ms: null };
  return { up: acc.up, down: acc.down, uptimePct: (acc.up / (acc.up + acc.down)) * 100, avgMs: acc.avg, p95Ms: acc.p95 };
}
