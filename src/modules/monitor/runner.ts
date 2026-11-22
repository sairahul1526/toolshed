/**
 * The check runner. Once a minute `dispatchMinute` finds the monitors due in that minute, runs up
 * to INLINE_MAX of them right away and hands the rest to the queue in chunks. Results go into one
 * JSON row per workspace per minute; a monitor row is written only when its state or streak changes.
 */
import type { Env } from '../../env';
import { moduleContext } from '../../core/registry';
import { enqueue, once } from '../../core/jobs';
import { newId } from '../../core/db';
import { runCheck, type CheckResult } from './checks';
import type { MaintenanceRow, MonitorRow } from './schema';
import { advance, heartbeatDeadline, runtimeOf, type StateEvent } from './state';
import { activeOccurrence, isCovered, maintenanceTick, workspaceZone, type Occurrence } from './maintenance';
import { MINUTE, minuteOf } from './time';
import { remindDown } from './alerts';

/** How many checks one cron run does itself. The rest go to the queue. Keeps a run well inside Workers Free limits. */
export const INLINE_MAX = 20;
export const CHUNK_SIZE = 20;

export const runnerConfig = {
  /** Wait before the quick second look at a failed check. Tests set it to 0. */
  confirmDelayMs: 1500,
};

export interface Entry {
  m: MonitorRow;
  r: CheckResult;
  /** Skip the "failures in a row" rule (a heartbeat that reported failure). */
  immediate?: boolean;
}

export interface EventItem {
  monitorId: string;
  events: StateEvent[];
  at: number;
  code: number | null;
  error: string | null;
  ms: number;
}

const sleep = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

/** Run a check; when it fails and the monitor is not already down, look once more before counting the failure. */
export async function checkWithConfirm(m: MonitorRow): Promise<CheckResult> {
  const first = await runCheck(m);
  if (first.ok || m.status === 'down' || m.fail_after <= 1) return first;
  await sleep(runnerConfig.confirmDelayMs);
  const second = await runCheck(m);
  return second.ok ? second : first;
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function heartbeatEntry(m: MonitorRow, at: number): Entry | null {
  if (m.hb_last_kind === 'fail') {
    const note = m.hb_last_note ? `: ${m.hb_last_note.slice(0, 80)}` : '';
    return { m, r: { ok: false, ms: 0, code: m.hb_last_code, error: `The job reported a failure${note}` }, immediate: true };
  }
  const deadline = heartbeatDeadline(m);
  if (deadline !== null && at > deadline) {
    const error = m.hb_last_ping_at ? 'No ping received in time' : 'Never pinged';
    return { m, r: { ok: false, ms: 0, code: null, error }, immediate: true };
  }
  if (m.status === 'pending' && !m.hb_last_ping_at) return null;
  return { m, r: { ok: true, ms: 0, code: null, error: null } };
}

function multiInsert(env: Env, table: string, cols: string[], rows: unknown[][], tail = ''): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const per = Math.max(1, Math.floor(90 / cols.length));
  for (let i = 0; i < rows.length; i += per) {
    const slice = rows.slice(i, i + per);
    const marks = slice.map((_, r) => `(${cols.map((_, c) => `?${r * cols.length + c + 1}`).join(', ')})`).join(', ');
    out.push(env.DB.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${marks}${tail}`).bind(...slice.flat()));
  }
  return out;
}

/** Fold results into monitor state and storage for one workspace and one minute. */
export async function applyResults(env: Env, orgId: string, entries: Entry[], minute: number, chunk: string, active: Occurrence[], at = minute): Promise<void> {
  if (entries.length === 0) return;
  const stmts: D1PreparedStatement[] = [];
  const results: unknown[] = [];
  const changes: unknown[][] = [];
  const failures: unknown[][] = [];
  const events: EventItem[] = [];

  for (const { m, r, immediate } of entries) {
    if (isCovered(m.id, active)) {
      results.push([m.id, 1, r.ms, r.code ?? 0, 'm', '']);
      continue;
    }
    const cur = runtimeOf(m);
    const a = advance(cur, r, { failAfter: immediate ? 1 : m.fail_after, slowMs: m.slow_ms, slowAfter: m.slow_after }, at);
    results.push([m.id, r.ok ? 1 : 0, r.ms, r.code ?? 0, a.next.slow ? 's' : '', (r.error ?? '').slice(0, 100)]);
    if (a.changed) {
      stmts.push(
        env.DB.prepare(
          `UPDATE mon_monitors SET status = ?3, slow = ?4, fail_streak = ?5, slow_streak = ?6, since_at = ?7, last_error = ?8, last_code = ?9, updated_at = ?10
           WHERE org_id = ?1 AND id = ?2`,
        ).bind(orgId, m.id, a.next.status, a.next.slow, a.next.fail_streak, a.next.slow_streak, a.next.since_at, a.next.last_error, a.next.last_code, at),
      );
    }
    if (a.events.includes('down') || a.events.includes('up') || a.firstUp) {
      changes.push([newId('chg', at), orgId, m.id, a.next.status, at, r.code, r.error?.slice(0, 200) ?? null]);
    }
    if (!r.ok && cur.fail_streak < Math.max(1, immediate ? 1 : m.fail_after)) {
      failures.push([newId('fai', at), orgId, m.id, at, r.code, r.ms, r.error?.slice(0, 200) ?? null]);
    }
    const alertable = a.events.filter((e) => e !== 'unslow');
    if (alertable.length) events.push({ monitorId: m.id, events: alertable, at, code: r.code, error: r.error, ms: r.ms });
  }

  stmts.push(
    env.DB.prepare(
      `INSERT INTO mon_minutes (id, org_id, minute, chunk, results, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (org_id, minute, chunk) DO NOTHING`,
    ).bind(newId('min', minute), orgId, minute, chunk, JSON.stringify(results), at),
  );
  stmts.push(...multiInsert(env, 'mon_state_changes', ['id', 'org_id', 'monitor_id', 'status', 'at', 'status_code', 'error'], changes));
  stmts.push(...multiInsert(env, 'mon_failures', ['id', 'org_id', 'monitor_id', 'at', 'status_code', 'ms', 'error'], failures));
  await env.DB.batch(stmts);
  if (events.length) await enqueue(env, 'monitor.events', { orgId, items: events });
}

/** Run one check for a person who pressed "Check now" or just created a monitor, and record it. */
export async function checkNow(env: Env, orgId: string, m: MonitorRow, at = Date.now()): Promise<CheckResult> {
  const r = m.type === 'http' ? await runCheck(m) : { ok: m.status !== 'down', ms: 0, code: null, error: m.last_error };
  if (m.type === 'http') {
    const ws = await orgActive(env, orgId, at);
    await applyResults(env, orgId, [{ m, r }], minuteOf(at), `now-${m.id}`, ws, at);
  }
  return r;
}

async function orgActive(env: Env, orgId: string, at: number): Promise<Occurrence[]> {
  const { results } = await env.DB.prepare(
    `SELECT * FROM mon_maintenance WHERE org_id = ?2 AND ((recurrence = 'none' AND starts_at <= ?1 AND starts_at + duration_min * 60000 > ?1) OR (recurrence != 'none'))`,
  )
    .bind(at, orgId)
    .all<MaintenanceRow>();
  const tz = await workspaceZone(env, orgId);
  return results.map((m) => activeOccurrence(m, tz, at)).filter((o): o is Occurrence => o !== null);
}

/** The cron entry. Safe to call twice for the same minute: results are stored once, state moves once per call. */
export async function dispatchMinute(env: Env, when: Date | number): Promise<{ checked: number; queued: number }> {
  const at = typeof when === 'number' ? when : when.getTime();
  const minute = minuteOf(at);
  const active = await maintenanceTick(env, minute);

  const due = (
    await env.DB.prepare(
      `SELECT * FROM mon_monitors WHERE type = 'http' AND paused = 0 AND sample = 0 AND (?1 % interval_min) = (slot % interval_min) ORDER BY org_id, id`,
    )
      .bind(Math.floor(minute / MINUTE))
      .all<MonitorRow>()
  ).results;
  const beats = (await env.DB.prepare(`SELECT * FROM mon_monitors WHERE type = 'heartbeat' AND paused = 0 AND sample = 0`).all<MonitorRow>()).results;

  const inline = due.slice(0, INLINE_MAX);
  const overflow = due.slice(INLINE_MAX);

  const checked = await pool(inline, 10, async (m) => ({ m, r: await checkWithConfirm(m) }));
  const byOrg = new Map<string, Entry[]>();
  for (const e of checked) byOrg.set(e.m.org_id, [...(byOrg.get(e.m.org_id) ?? []), e]);
  for (const m of beats) {
    const e = heartbeatEntry(m, at);
    if (e) byOrg.set(m.org_id, [...(byOrg.get(m.org_id) ?? []), e]);
  }
  for (const [orgId, entries] of byOrg) {
    try {
      await applyResults(env, orgId, entries, minute, '0', active.get(orgId) ?? [], at);
    } catch (err) {
      console.error('[monitor] could not store results', orgId, err);
    }
  }

  let queued = 0;
  const overflowByOrg = new Map<string, string[]>();
  for (const m of overflow) overflowByOrg.set(m.org_id, [...(overflowByOrg.get(m.org_id) ?? []), m.id]);
  for (const [orgId, idsList] of overflowByOrg) {
    for (let i = 0; i < idsList.length; i += CHUNK_SIZE) {
      await enqueue(env, 'monitor.chunk', { orgId, minute, at, monitorIds: idsList.slice(i, i + CHUNK_SIZE), chunk: `c${i / CHUNK_SIZE + 1}` });
      queued++;
    }
  }

  try {
    await remindDown(env, at);
  } catch (err) {
    console.error('[monitor] reminders failed', err);
  }
  return { checked: inline.length, queued };
}

/** Queue job: check a chunk of monitors that did not fit in the cron run. */
export async function processChunk(env: Env, payload: unknown): Promise<void> {
  const p = payload as { orgId: string; minute: number; at: number; monitorIds: string[]; chunk: string };
  await once(env, `mon:chunk:${p.orgId}:${p.minute}:${p.chunk}`, 900, async () => {
    const ctx = await moduleContext(env, p.orgId);
    const rows = (await ctx.db.list<MonitorRow>('mon_monitors', { limit: 500 })).filter((m) => p.monitorIds.includes(m.id) && m.paused === 0 && m.type === 'http');
    const entries = await pool(rows, 10, async (m) => ({ m, r: await checkWithConfirm(m) }));
    const active = (await orgActive(env, p.orgId, p.at)) ?? [];
    await applyResults(env, p.orgId, entries, p.minute, p.chunk, active, p.at);
  });
}
