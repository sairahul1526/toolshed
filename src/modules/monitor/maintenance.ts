/**
 * Maintenance windows: one-off or repeating (daily, weekly, monthly) in the workspace time zone.
 * While one is active the monitors it covers are not checked for alerts, and the status page shows it.
 */
import { newId, parseJson } from '../../core/db';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import { errors, parse } from '../../core/errors';
import { getSetting } from '../../core/settings';
import type { Env } from '../../env';
import type { Ctx } from './monitors';
import { type MaintenanceRow, ids, maintenanceSchema } from './schema';
import { DAY, MINUTE, localParts, localToUtc } from './time';

export interface Occurrence {
  id: string;
  title: string;
  body: string | null;
  start: number;
  end: number;
  monitorIds: string[];
  notify: boolean;
}

function period(r: MaintenanceRow['recurrence']): number {
  return r === 'daily' ? DAY : r === 'weekly' ? 7 * DAY : r === 'monthly' ? 31 * DAY : 0;
}

/** Start of occurrence number `k` (0 is the first), keeping the same wall-clock time across daylight saving. */
export function occurrenceStart(m: Pick<MaintenanceRow, 'starts_at' | 'recurrence'>, k: number, tz: string): number {
  if (k === 0 || m.recurrence === 'none') return m.starts_at;
  const p = localParts(tz, m.starts_at);
  if (m.recurrence === 'daily') return localToUtc(tz, p.year, p.month, p.day + k, p.hour, p.minute);
  if (m.recurrence === 'weekly') return localToUtc(tz, p.year, p.month, p.day + 7 * k, p.hour, p.minute);
  const monthIndex = p.month - 1 + k;
  const year = p.year + Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return localToUtc(tz, year, month, Math.min(p.day, last), p.hour, p.minute);
}

function toOccurrence(m: MaintenanceRow, start: number): Occurrence {
  return { id: m.id, title: m.title, body: m.body, start, end: start + m.duration_min * MINUTE, monitorIds: ids(m.monitor_ids), notify: m.notify === 1 };
}

/** The occurrence that is running at `at`, or null. */
export function activeOccurrence(m: MaintenanceRow, tz: string, at: number): Occurrence | null {
  const found = occurrencesAround(m, tz, at).find((o) => o.start <= at && at < o.end);
  return found ?? null;
}

/** The running occurrence, or the next one to start, or null when none is left. */
export function currentOrNext(m: MaintenanceRow, tz: string, at: number): Occurrence | null {
  const list = occurrencesAround(m, tz, at);
  return list.find((o) => at < o.end) ?? null;
}

function occurrencesAround(m: MaintenanceRow, tz: string, at: number): Occurrence[] {
  if (m.recurrence === 'none') return [toOccurrence(m, m.starts_at)];
  const step = period(m.recurrence);
  const guess = Math.max(0, Math.floor((at - m.starts_at) / step));
  const out: Occurrence[] = [];
  for (let k = Math.max(0, guess - 2); k <= guess + 2; k++) {
    const start = occurrenceStart(m, k, tz);
    if (m.recur_until !== null && start > m.recur_until) break;
    if (start >= m.starts_at) out.push(toOccurrence(m, start));
  }
  return out;
}

/** True when the monitor is covered by an active window at `at`. */
export function isCovered(monitorId: string, active: Occurrence[]): boolean {
  return active.some((o) => o.monitorIds.length === 0 || o.monitorIds.includes(monitorId));
}

/** Rows that could be running, about to start or in need of an "ended" announcement. */
export const RELEVANT_SQL = `(recurrence = 'none' AND starts_at + duration_min * 60000 >= ?1 - 3600000)
   OR (recurrence != 'none' AND (recur_until IS NULL OR recur_until >= ?1))
   OR (started_for IS NOT NULL AND (ended_for IS NULL OR ended_for != started_for))`;

export async function createMaintenance(ctx: Ctx, raw: unknown, opts: { at?: number; sample?: boolean } = {}): Promise<MaintenanceRow> {
  const at = opts.at ?? Date.now();
  const input = parse(maintenanceSchema, raw);
  const recurrence = input.recurrence ?? 'none';
  const step = period(recurrence);
  if (step && input.durationMin * MINUTE >= step) {
    throw errors.validation_failed(undefined, { durationMin: 'A repeating window has to be shorter than the time between repeats.' });
  }
  if (input.recurUntil !== undefined && input.recurUntil < input.startsAt) {
    throw errors.validation_failed(undefined, { recurUntil: 'The end date comes before the start.' });
  }
  return ctx.db.insert<MaintenanceRow>('mon_maintenance', {
    id: newId('mnt', at),
    title: input.title,
    body: input.body ?? null,
    starts_at: input.startsAt,
    duration_min: input.durationMin,
    recurrence,
    recur_until: recurrence === 'none' ? null : (input.recurUntil ?? null),
    monitor_ids: JSON.stringify(input.monitorIds ?? []),
    notify: input.notify === false ? 0 : 1,
    sample: opts.sample ? 1 : 0,
    created_at: at,
    updated_at: at,
  });
}

export async function updateMaintenance(ctx: Ctx, id: string, raw: unknown, at = Date.now()): Promise<MaintenanceRow> {
  const cur = await getMaintenance(ctx, id);
  const merged = {
    title: cur.title,
    body: cur.body ?? undefined,
    startsAt: cur.starts_at,
    durationMin: cur.duration_min,
    recurrence: cur.recurrence,
    recurUntil: cur.recur_until ?? undefined,
    monitorIds: ids(cur.monitor_ids),
    notify: cur.notify === 1,
    ...(raw as Record<string, unknown>),
  };
  const input = parse(maintenanceSchema, merged);
  const recurrence = input.recurrence ?? 'none';
  const step = period(recurrence);
  if (step && input.durationMin * MINUTE >= step) {
    throw errors.validation_failed(undefined, { durationMin: 'A repeating window has to be shorter than the time between repeats.' });
  }
  const moved = input.startsAt !== cur.starts_at || input.durationMin !== cur.duration_min || recurrence !== cur.recurrence;
  return (await ctx.db.update<MaintenanceRow>('mon_maintenance', id, {
    title: input.title,
    body: input.body ?? null,
    starts_at: input.startsAt,
    duration_min: input.durationMin,
    recurrence,
    recur_until: recurrence === 'none' ? null : (input.recurUntil ?? null),
    monitor_ids: JSON.stringify(input.monitorIds ?? []),
    notify: input.notify === false ? 0 : 1,
    ...(moved ? { started_for: null, ended_for: null } : {}),
    updated_at: at,
  }))!;
}

export async function getMaintenance(ctx: Ctx, id: string): Promise<MaintenanceRow> {
  const row = await ctx.db.get<MaintenanceRow>('mon_maintenance', id);
  if (!row) throw errors.not_found('We couldn’t find that maintenance window.');
  return row;
}

export async function listMaintenance(ctx: Ctx): Promise<MaintenanceRow[]> {
  return ctx.db.list<MaintenanceRow>('mon_maintenance', { orderBy: 'starts_at DESC', limit: 200 });
}

export async function deleteMaintenance(ctx: Ctx, id: string): Promise<void> {
  await getMaintenance(ctx, id);
  await ctx.db.remove('mon_maintenance', id);
}

export async function workspaceZone(env: Env, orgId: string): Promise<string> {
  const tz = await getSetting<string>(env, orgId, 'timezone', 'UTC');
  return typeof tz === 'string' && tz ? tz : 'UTC';
}

/**
 * Announce windows that started and ended since the last minute. Writes only when something changes.
 * Returns the windows that are active now, per workspace.
 */
export async function maintenanceTick(env: Env, at: number): Promise<Map<string, Occurrence[]>> {
  const { results } = await env.DB.prepare(`SELECT * FROM mon_maintenance WHERE ${RELEVANT_SQL}`).bind(at).all<MaintenanceRow>();
  const byOrg = new Map<string, MaintenanceRow[]>();
  for (const r of results) byOrg.set(r.org_id, [...(byOrg.get(r.org_id) ?? []), r]);
  const active = new Map<string, Occurrence[]>();
  for (const [orgId, rows] of byOrg) {
    const tz = await workspaceZone(env, orgId);
    for (const m of rows) {
      const now = activeOccurrence(m, tz, at);
      if (now) {
        active.set(orgId, [...(active.get(orgId) ?? []), now]);
        if (m.started_for !== now.start) {
          await env.DB.prepare('UPDATE mon_maintenance SET started_for = ?2 WHERE id = ?1').bind(m.id, now.start).run();
          await emit(env, { orgId, module: 'monitor', name: 'maintenance.started', subject: m.id, data: { title: m.title, start: now.start, end: now.end }, at });
          if (m.notify === 1) await notifyMaintenance(env, orgId, m, now, 'started');
        }
      } else if (m.started_for !== null && m.ended_for !== m.started_for) {
        await env.DB.prepare('UPDATE mon_maintenance SET ended_for = started_for WHERE id = ?1').bind(m.id).run();
        await emit(env, { orgId, module: 'monitor', name: 'maintenance.ended', subject: m.id, data: { title: m.title }, at });
        if (m.notify === 1) await notifyMaintenance(env, orgId, m, null, 'ended');
      }
    }
  }
  return active;
}

async function notifyMaintenance(env: Env, orgId: string, m: MaintenanceRow, occ: Occurrence | null, phase: 'started' | 'ended'): Promise<void> {
    await enqueue(env, 'monitor.notify', {
    orgId,
    kind: phase === 'started' ? 'maintenance_started' : 'maintenance_ended',
    maintenanceId: m.id,
    title: m.title,
    body: m.body,
    until: occ?.end ?? null,
    monitorIds: parseJson<string[]>(m.monitor_ids, []),
  });
}
