/**
 * Reading the numbers. Two paths give the same shapes:
 *
 *   - No filter: read an_rollups only, for any date range. One batch of small statements.
 *   - A filter (or a breakdown that is not stored per day, such as cities): read raw hits, which
 *     only exist inside the site's retention window. One scan for the whole dashboard.
 *
 * "Visitors" for a range of several days is the sum of each day's unique visitors: the id that
 * tells visitors apart changes every day by design, so the same person on two days counts twice.
 */
import type { OrgDb, Scalar } from '../../core/db';
import { errors } from '../../core/errors';
import { analyticsErrors, type Goal, type Site } from './sites';
import { dimSpecs, type DimSpec, METRICS, rawOnlySpecs, slicedSelect } from './rollup';
import { addDays, dayStart, daysBetween, eachDay, HOUR, isDay, localDay, MINUTE } from './time';

export interface Metrics {
  visitors: number;
  visits: number;
  pageviews: number;
  events: number;
  unbounces: number;
  duration: number;
}
export interface Row extends Metrics {
  value: string;
}

export const ZERO: Metrics = { visitors: 0, visits: 0, pageviews: 0, events: 0, unbounces: 0, duration: 0 };

/** The ratios people read, worked out from the stored sums. Null when there is nothing to divide by. */
export function derive(m: Metrics): { bounceRate: number | null; viewsPerVisit: number | null; visitSeconds: number | null } {
  if (m.visits <= 0) return { bounceRate: null, viewsPerVisit: null, visitSeconds: null };
  return {
    bounceRate: Math.max(0, Math.min(1, (m.visits - m.unbounces) / m.visits)),
    viewsPerVisit: m.pageviews / m.visits,
    visitSeconds: m.duration / m.visits / 1000,
  };
}

// ---------------------------------------------------------------------------------------------
// Date ranges
// ---------------------------------------------------------------------------------------------

export const PERIODS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
  { id: '30d', label: 'Last 30 days' },
  { id: 'month', label: 'This month' },
  { id: 'lastmonth', label: 'Last month' },
  { id: '12mo', label: 'Last 12 months' },
  { id: 'year', label: 'This year' },
  { id: 'custom', label: 'Custom range' },
] as const;
export type PeriodId = (typeof PERIODS)[number]['id'];
export const DEFAULT_PERIOD: PeriodId = '7d';
const MAX_RANGE_DAYS = 1100;

export interface Range {
  period: PeriodId;
  label: string;
  /** Site-local days, both included. */
  from: string;
  to: string;
  prevFrom: string;
  prevTo: string;
  bucket: 'hour' | 'day' | 'month';
  today: string;
}

function monthStart(day: string, shift = 0): string {
  const d = new Date(Date.parse(`${day.slice(0, 7)}-01T00:00:00Z`));
  d.setUTCMonth(d.getUTCMonth() + shift);
  return d.toISOString().slice(0, 10);
}

function shortDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Turn `?period=…&from=…&to=…` into days in the site's time zone. Throws for a custom range that makes no sense. */
export function resolveRange(site: Pick<Site, 'timezone'>, q: { period?: string | null; from?: string | null; to?: string | null }, now = Date.now()): Range {
  const today = localDay(site.timezone, now);
  const known = PERIODS.find((p) => p.id === q.period);
  let period: PeriodId = known?.id ?? (q.from && q.to ? 'custom' : DEFAULT_PERIOD);
  let from = today;
  let to = today;
  if (period === 'custom') {
    if (!q.from || !q.to || !isDay(q.from) || !isDay(q.to)) period = DEFAULT_PERIOD;
    else {
      if (q.from > q.to) throw analyticsErrors.bad_range();
      if (daysBetween(q.from, q.to) >= MAX_RANGE_DAYS) throw analyticsErrors.range_too_long();
      from = q.from;
      to = q.to;
    }
  }
  if (period === 'yesterday') from = to = addDays(today, -1);
  else if (period === '7d') from = addDays(today, -6);
  else if (period === '30d') from = addDays(today, -29);
  else if (period === 'month') from = monthStart(today);
  else if (period === 'lastmonth') {
    from = monthStart(today, -1);
    to = addDays(monthStart(today), -1);
  } else if (period === '12mo') from = monthStart(today, -11);
  else if (period === 'year') from = `${today.slice(0, 4)}-01-01`;

  const days = daysBetween(from, to) + 1;
  const prevTo = addDays(from, -1);
  const label = period === 'custom' ? (from === to ? shortDay(from) : `${shortDay(from)} to ${shortDay(to)}`) : PERIODS.find((p) => p.id === period)!.label;
  return { period, label, from, to, prevFrom: addDays(prevTo, -(days - 1)), prevTo, bucket: days === 1 ? 'hour' : days <= 92 ? 'day' : 'month', today };
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

export const FILTER_KEYS = [
  'page', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'country', 'region', 'city', 'device', 'browser', 'os', 'event', 'goal',
] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export type Filters = Partial<Record<FilterKey, string>>;

/** Dimensions stored per day. */
export const STORED_DIMS = ['page', 'entry', 'exit', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'country', 'device', 'browser', 'os', 'event'] as const;
/** Dimensions that need raw hits. */
export const RAW_DIMS = ['region', 'city'] as const;
export const ALL_DIMS = [...STORED_DIMS, ...RAW_DIMS] as const;
export type Dim = (typeof ALL_DIMS)[number];

export function isDim(text: string): text is Dim {
  return (ALL_DIMS as readonly string[]).includes(text);
}

export function readFilters(get: (key: string) => string | undefined | null): Filters {
  const out: Filters = {};
  for (const key of FILTER_KEYS) {
    const v = get(key)?.trim();
    if (v) out[key] = v.slice(0, 300);
  }
  return out;
}

function likePattern(pattern: string): string {
  return pattern.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%');
}

interface FilterSql {
  where: string[];
  binds: Scalar[];
  /** A page or event filter narrows to single hits, so visit numbers (bounce, time) no longer mean anything. */
  partial: boolean;
}

/** A goal filter is shorthand for the page or event the goal counts. */
export function expandGoal(filters: Filters, goals: Goal[]): Filters {
  if (!filters.goal) return filters;
  const { goal: id, ...rest } = filters;
  const goal = goals.find((g) => g.id === id);
  if (!goal) return rest;
  return goal.kind === 'page' ? { ...rest, page: goal.match } : { ...rest, event: goal.match };
}

function filterSql(filters: Filters): FilterSql {
  const partial = !!(filters.page || filters.event);
  const specs = [...dimSpecs(), ...rawOnlySpecs('h.nv')];
  const where: string[] = [];
  const binds: Scalar[] = [];
  for (const [key, value] of Object.entries(filters) as [FilterKey, string][]) {
    if (key === 'goal') continue;
    if (key === 'page' && value.includes('*')) {
      where.push("(h.kind = 'p' AND h.path LIKE ? ESCAPE '\\')");
      binds.push(likePattern(value));
      continue;
    }
    const spec = specs.find((s) => s.k === key);
    if (!spec) continue;
    where.push(`(${spec.value}) = ?`);
    binds.push(value);
  }
  return { where, binds, partial };
}

export function hasFilters(filters: Filters): boolean {
  return Object.keys(filters).length > 0;
}

// ---------------------------------------------------------------------------------------------
// The report behind the dashboard
// ---------------------------------------------------------------------------------------------

export interface Series {
  labels: string[];
  visitors: number[];
  pageviews: number[];
  prevVisitors: number[] | null;
}

export interface GoalResult {
  goal: Goal;
  /** Different visitors who reached it (summed per day). */
  uniques: number;
  total: number;
  /** Share of all visitors in the range, 0 to 1. Null when there were no visitors. */
  rate: number | null;
}

export interface Report {
  range: Range;
  filters: Filters;
  mode: 'totals' | 'raw';
  /** Set when a filtered view cannot be shown. The rest is then empty. */
  blocked: 'expired' | 'too_much' | null;
  partial: boolean;
  totals: Metrics;
  prev: Metrics | null;
  series: Series;
  panels: Partial<Record<Dim, Row[]>>;
  goals: GoalResult[];
}

export interface ReportOptions {
  compare?: boolean;
  /** Which breakdowns to load. */
  dims: Dim[];
  /** Rows per breakdown. */
  limit?: number;
  goals?: Goal[];
}

type DbRow = Row & { dim: string; day?: string };

const SUMS = METRICS.map((m) => `SUM(${m}) AS ${m}`).join(', ');
const RANK = `CASE WHEN dim IN ('entry', 'exit') THEN SUM(visits) WHEN dim = 'event' THEN SUM(events) ELSE SUM(visitors) END DESC, SUM(pageviews) DESC, value`;
const KEEP = `NOT (dim = 'exit' AND SUM(visits) <= 0) AND NOT (dim = 'page' AND SUM(pageviews) <= 0)`;
const RAW_ROW_LIMIT = 250_000;

function add(into: Metrics, row: Metrics): void {
  for (const m of METRICS) into[m] += Number(row[m]) || 0;
}

function toMetrics(r: Metrics): Metrics {
  return { visitors: Number(r.visitors) || 0, visits: Number(r.visits) || 0, pageviews: Number(r.pageviews) || 0, events: Number(r.events) || 0, unbounces: Number(r.unbounces) || 0, duration: Number(r.duration) || 0 };
}

function toRow(r: DbRow): Row {
  return { value: r.value, ...toMetrics(r) };
}

function buildSeries(range: Range, byDay: Map<string, Metrics>, byHour: Map<string, Metrics>, prevByDay: Map<string, Metrics> | null, prevByHour: Map<string, Metrics> | null): Series {
  const out: Series = { labels: [], visitors: [], pageviews: [], prevVisitors: prevByDay ? [] : null };
  if (range.bucket === 'hour') {
    for (let h = 0; h < 24; h++) {
      const key = String(h).padStart(2, '0');
      out.labels.push(`${key}:00`);
      out.visitors.push(byHour.get(key)?.visitors ?? 0);
      out.pageviews.push(byHour.get(key)?.pageviews ?? 0);
      out.prevVisitors?.push(prevByHour?.get(key)?.visitors ?? 0);
    }
    return out;
  }
  const days = eachDay(range.from, range.to);
  const prevDays = eachDay(range.prevFrom, range.prevTo);
  if (range.bucket === 'day') {
    days.forEach((day, i) => {
      out.labels.push(new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }));
      out.visitors.push(byDay.get(day)?.visitors ?? 0);
      out.pageviews.push(byDay.get(day)?.pageviews ?? 0);
      out.prevVisitors?.push(prevByDay?.get(prevDays[i] ?? '')?.visitors ?? 0);
    });
    return out;
  }
  const months = (list: string[], src: Map<string, Metrics> | null) => {
    const m = new Map<string, Metrics>();
    for (const day of list) {
      const key = day.slice(0, 7);
      const sum = m.get(key) ?? { ...ZERO };
      const row = src?.get(day);
      if (row) add(sum, row);
      m.set(key, sum);
    }
    return [...m.entries()];
  };
  const prevMonths = months(prevDays, prevByDay);
  months(days, byDay).forEach(([key, sum], i) => {
    out.labels.push(new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }));
    out.visitors.push(sum.visitors);
    out.pageviews.push(sum.pageviews);
    out.prevVisitors?.push(prevMonths[i]?.[1].visitors ?? 0);
  });
  return out;
}

function goalWhere(goal: Goal, column: { page: string; event: string }): { sql: string; bind: string } {
  if (goal.kind === 'event') return { sql: `${column.event} = ?`, bind: goal.match };
  return goal.match.includes('*') ? { sql: `${column.page} LIKE ? ESCAPE '\\'`, bind: likePattern(goal.match) } : { sql: `${column.page} = ?`, bind: goal.match };
}

/** Why a raw read cannot run for this range, or null when it can. One small read of the daily totals. */
async function rawBlock(db: OrgDb, site: Site, from: string, to: string, today: string): Promise<Report['blocked']> {
  if (from < addDays(today, -site.retention_days)) return 'expired';
  const est = await db.first<{ n: number | null }>(
    "SELECT SUM(pageviews + events) AS n FROM an_rollups WHERE org_id = :org AND site_id = ? AND dim = 'total' AND day BETWEEN ? AND ?",
    site.id, from, to,
  );
  return (est?.n ?? 0) > RAW_ROW_LIMIT ? 'too_much' : null;
}

/** The time window of a range of site-local days, with slack: a hit's stored day is what decides. */
function rawWindow(site: Site, from: string, to: string): [number, number] {
  return [dayStart(site.timezone, from) - 2 * HOUR, dayStart(site.timezone, addDays(to, 1)) + 2 * HOUR];
}

function rawStatement(db: OrgDb, site: Site, specs: DimSpec[], from: string, to: string, f: FilterSql, limit: number): D1PreparedStatement {
  const [start, end] = rawWindow(site, from, to);
  const where = ['h.org_id = ?1', 'h.site_id = ?2', 'h.at >= ?3', 'h.at < ?4', 'h.day BETWEEN ?5 AND ?6', ...f.where.map((w, i) => w.replace('?', `?${i + 8}`))].join(' AND ');
  const { cte, select } = slicedSelect(specs, { where });
  const sql = `${cte} SELECT dim, value, ${METRICS.join(', ')} FROM (
      SELECT g.*, ROW_NUMBER() OVER (PARTITION BY dim ORDER BY CASE WHEN dim IN ('entry', 'exit') THEN visits WHEN dim = 'event' THEN events ELSE visitors END DESC, pageviews DESC, value) AS rn
      FROM (${select}) g WHERE NOT (dim = 'exit' AND visits <= 0) AND NOT (dim = 'page' AND pageviews <= 0)
    ) WHERE rn <= CASE WHEN dim IN ('total', 'day', 'hour') THEN 2000 ELSE ?7 END`;
  return db.d1.prepare(sql).bind(db.orgId, site.id, start, end, from, to, limit, ...f.binds);
}

function specsFor(dims: readonly string[], vis: 'h.nv' | 'h.np'): DimSpec[] {
  return [...dimSpecs(vis), ...rawOnlySpecs(vis)].filter((s) => dims.includes(s.dim));
}

export async function report(db: OrgDb, site: Site, range: Range, rawFilters: Filters, opts: ReportOptions): Promise<Report> {
  const goals = opts.goals ?? [];
  const filters = expandGoal(rawFilters, goals);
  const limit = opts.limit ?? 10;
  const needsRaw = hasFilters(filters) || opts.dims.some((d) => (RAW_DIMS as readonly string[]).includes(d));
  const out: Report = {
    range, filters: rawFilters, mode: needsRaw ? 'raw' : 'totals', blocked: null, partial: false,
    totals: { ...ZERO }, prev: opts.compare ? { ...ZERO } : null,
    series: buildSeries(range, new Map(), new Map(), opts.compare ? new Map() : null, null), panels: {}, goals: [],
  };
  const byDay = new Map<string, Metrics>();
  const byHour = new Map<string, Metrics>();
  const prevByDay = opts.compare ? new Map<string, Metrics>() : null;
  const prevByHour = opts.compare ? new Map<string, Metrics>() : null;
  const single = range.bucket === 'hour';

  if (!needsRaw) {
    const head = `SELECT day, dim, value, ${METRICS.join(', ')} FROM an_rollups WHERE org_id = ?1 AND site_id = ?2 AND dim IN ('total'${single ? ", 'hour'" : ''}) AND day BETWEEN ?3 AND ?4`;
    const stmts = [db.d1.prepare(head).bind(db.orgId, site.id, range.from, range.to)];
    if (opts.compare) stmts.push(db.d1.prepare(head).bind(db.orgId, site.id, range.prevFrom, range.prevTo));
    if (opts.dims.length) {
      stmts.push(
        db.d1
          .prepare(
            `SELECT dim, value, ${METRICS.join(', ')} FROM (
               SELECT dim, value, ${SUMS}, ROW_NUMBER() OVER (PARTITION BY dim ORDER BY ${RANK}) AS rn
               FROM an_rollups WHERE org_id = ?1 AND site_id = ?2 AND dim IN (${opts.dims.map((d) => `'${d}'`).join(', ')}) AND day BETWEEN ?3 AND ?4
               GROUP BY dim, value HAVING ${KEEP}
             ) WHERE rn <= ?5`,
          )
          .bind(db.orgId, site.id, range.from, range.to, limit),
      );
    }
    for (const goal of goals) {
      const w = goalWhere(goal, { page: 'value', event: 'value' });
      stmts.push(
        db.d1
          .prepare(`SELECT SUM(visitors) AS visitors, SUM(pageviews + events) AS total FROM an_rollups WHERE org_id = ?1 AND site_id = ?2 AND dim = ?3 AND day BETWEEN ?4 AND ?5 AND ${w.sql.replace('?', '?6')}`)
          .bind(db.orgId, site.id, goal.kind, range.from, range.to, w.bind),
      );
    }
    const results = await db.d1.batch<DbRow & { total?: number }>(stmts);
    let i = 0;
    for (const r of results[i++]?.results ?? []) {
      if (r.dim === 'total') {
        add(out.totals, r);
        byDay.set(r.day!, toMetrics(r));
      } else byHour.set(r.value, toRow(r));
    }
    if (opts.compare) {
      for (const r of results[i++]?.results ?? []) {
        if (r.dim === 'total') {
          add(out.prev!, r);
          prevByDay!.set(r.day!, toMetrics(r));
        } else prevByHour!.set(r.value, toRow(r));
      }
    }
    if (opts.dims.length) {
      for (const d of opts.dims) out.panels[d] = [];
      for (const r of results[i++]?.results ?? []) out.panels[r.dim as Dim]?.push(toRow(r));
    }
    for (const goal of goals) {
      const r = results[i++]?.results[0];
      const uniques = Number(r?.visitors) || 0;
      out.goals.push({ goal, uniques, total: Number(r?.total) || 0, rate: out.totals.visitors > 0 ? Math.min(1, uniques / out.totals.visitors) : null });
    }
    out.series = buildSeries(range, byDay, byHour, prevByDay, prevByHour);
    return out;
  }

  out.blocked = await rawBlock(db, site, opts.compare ? range.prevFrom : range.from, range.to, range.today);
  // The earlier period may be past the window while the current one is not: show it without the comparison.
  let compare = !!opts.compare;
  if (out.blocked === 'expired' && compare && range.from >= addDays(range.today, -site.retention_days)) {
    out.blocked = await rawBlock(db, site, range.from, range.to, range.today);
    compare = false;
    out.prev = null;
  }
  if (out.blocked) return out;

  const f = filterSql(filters);
  out.partial = f.partial;
  const vis = f.partial ? 'h.np' : 'h.nv';
  const stmts = [rawStatement(db, site, specsFor(['total', 'day', 'hour', ...opts.dims], vis), range.from, range.to, f, limit)];
  if (compare) stmts.push(rawStatement(db, site, specsFor(['total', 'day', 'hour'], vis), range.prevFrom, range.prevTo, f, limit));
  if (goals.length) {
    // Every goal in one scan: a pair of conditional sums each.
    const [start, end] = rawWindow(site, range.from, range.to);
    const binds: Scalar[] = [db.orgId, site.id, start, end, range.from, range.to];
    const where = ['h.org_id = ?1', 'h.site_id = ?2', 'h.at >= ?3', 'h.at < ?4', 'h.day BETWEEN ?5 AND ?6'];
    const cols: string[] = [];
    goals.forEach((goal, n) => {
      const w = goalWhere(goal, { page: 'h.path', event: 'h.name' });
      binds.push(w.bind);
      const cond = `(h.kind = '${goal.kind === 'page' ? 'p' : 'e'}' AND ${w.sql.replace('?', `?${binds.length}`)})`;
      cols.push(`COALESCE(SUM(CASE WHEN ${cond} THEN h.np END), 0) AS u${n}, COALESCE(SUM(${cond}), 0) AS n${n}`);
    });
    f.where.forEach((w, n) => {
      binds.push(f.binds[n]!);
      where.push(w.replace('?', `?${binds.length}`));
    });
    stmts.push(db.d1.prepare(`SELECT ${cols.join(', ')} FROM an_hits h WHERE ${where.join(' AND ')}`).bind(...binds));
  }
  const results = await db.d1.batch<DbRow & Record<string, number>>(stmts);
  for (const d of opts.dims) out.panels[d] = [];
  for (const r of results[0]?.results ?? []) {
    if (r.dim === 'total') out.totals = toMetrics(r);
    else if (r.dim === 'day') byDay.set(r.value, toRow(r));
    else if (r.dim === 'hour') byHour.set(r.value, toRow(r));
    else out.panels[r.dim as Dim]?.push(toRow(r));
  }
  let i = 1;
  if (compare) {
    for (const r of results[i++]?.results ?? []) {
      if (r.dim === 'total') out.prev = toMetrics(r);
      else if (r.dim === 'day') prevByDay!.set(r.value, toRow(r));
      else if (r.dim === 'hour') prevByHour!.set(r.value, toRow(r));
    }
  }
  if (goals.length) {
    const r = results[i++]?.results[0];
    goals.forEach((goal, n) => {
      const uniques = Number(r?.[`u${n}`]) || 0;
      out.goals.push({ goal, uniques, total: Number(r?.[`n${n}`]) || 0, rate: out.totals.visitors > 0 ? Math.min(1, uniques / out.totals.visitors) : null });
    });
  }
  out.series = buildSeries(range, byDay, byHour, compare ? prevByDay : null, compare ? prevByHour : null);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Page markers
// ---------------------------------------------------------------------------------------------

function packCursor(value: Record<string, string | number>): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unpackCursor(cursor: string | null | undefined): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw errors.bad_request('That page marker isn’t valid. Start again from the first page.');
}

// ---------------------------------------------------------------------------------------------
// One breakdown, paged (the "see all" pages, the API and the CSV files)
// ---------------------------------------------------------------------------------------------

export interface Breakdown {
  items: Row[];
  nextCursor: string | null;
  mode: 'totals' | 'raw';
  blocked: Report['blocked'];
  partial: boolean;
}

export async function breakdown(
  db: OrgDb,
  site: Site,
  range: Range,
  rawFilters: Filters,
  dim: Dim,
  opts: { limit?: number; cursor?: string | null; goals?: Goal[] } = {},
): Promise<Breakdown> {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 1000));
  const offset = Math.max(0, Math.floor(Number(unpackCursor(opts.cursor)?.o) || 0));
  const filters = expandGoal(rawFilters, opts.goals ?? []);
  const raw = hasFilters(filters) || (RAW_DIMS as readonly string[]).includes(dim);
  let rows: Row[];
  let partial = false;
  if (!raw) {
    const found = await db.d1
      .prepare(
        `SELECT dim, value, ${SUMS} FROM an_rollups WHERE org_id = ?1 AND site_id = ?2 AND dim = ?3 AND day BETWEEN ?4 AND ?5
         GROUP BY dim, value HAVING ${KEEP} ORDER BY ${RANK} LIMIT ?6 OFFSET ?7`,
      )
      .bind(db.orgId, site.id, dim, range.from, range.to, limit + 1, offset)
      .all<DbRow>();
    rows = found.results.map(toRow);
  } else {
    const blocked = await rawBlock(db, site, range.from, range.to, range.today);
    if (blocked) return { items: [], nextCursor: null, mode: 'raw', blocked, partial: false };
    const f = filterSql(filters);
    partial = f.partial;
    const [start, end] = rawWindow(site, range.from, range.to);
    const where = ['h.org_id = ?1', 'h.site_id = ?2', 'h.at >= ?3', 'h.at < ?4', 'h.day BETWEEN ?5 AND ?6', ...f.where.map((w, i) => w.replace('?', `?${i + 9}`))].join(' AND ');
    const { cte, select } = slicedSelect(specsFor([dim], partial ? 'h.np' : 'h.nv'), { where });
    const found = await db.d1
      .prepare(
        `${cte} SELECT * FROM (${select}) WHERE NOT (dim = 'exit' AND visits <= 0) AND NOT (dim = 'page' AND pageviews <= 0)
         ORDER BY CASE WHEN dim IN ('entry', 'exit') THEN visits WHEN dim = 'event' THEN events ELSE visitors END DESC, pageviews DESC, value LIMIT ?7 OFFSET ?8`,
      )
      .bind(db.orgId, site.id, start, end, range.from, range.to, limit + 1, offset, ...f.binds)
      .all<DbRow>();
    rows = found.results.map(toRow);
  }
  const more = rows.length > limit;
  return { items: rows.slice(0, limit), nextCursor: more ? packCursor({ o: offset + limit }) : null, mode: raw ? 'raw' : 'totals', blocked: null, partial };
}

// ---------------------------------------------------------------------------------------------
// Live, health, event properties, raw rows, site cards
// ---------------------------------------------------------------------------------------------

export const LIVE_WINDOW_MS = 5 * MINUTE;

export interface Live {
  /** Different visitors with a hit in the last five minutes. */
  visitors: number;
  /** When the site's first hit arrived, or null when it is still waiting for one. */
  firstHitAt: number | null;
  pages: { value: string; visitors: number }[];
}

export async function live(db: OrgDb, site: Site, now = Date.now(), withPages = false): Promise<Live> {
  const since = now - LIVE_WINDOW_MS;
  const stmts = [
    db.d1
      .prepare(
        `SELECT (SELECT COUNT(DISTINCT visitor) FROM an_hits WHERE org_id = ?1 AND site_id = ?2 AND at > ?3) AS visitors,
                (SELECT MIN(at) FROM an_hits WHERE org_id = ?1 AND site_id = ?2) AS first_at`,
      )
      .bind(db.orgId, site.id, since),
  ];
  if (withPages) {
    stmts.push(
      db.d1
        .prepare(
          `SELECT path AS value, COUNT(DISTINCT visitor) AS visitors FROM an_hits WHERE org_id = ?1 AND site_id = ?2 AND at > ?3 AND kind = 'p'
           GROUP BY path ORDER BY visitors DESC, path LIMIT 10`,
        )
        .bind(db.orgId, site.id, since),
    );
  }
  const [head, pages] = await db.d1.batch<{ visitors: number; first_at: number | null; value: string }>(stmts);
  const row = head?.results[0];
  return {
    visitors: Number(row?.visitors) || 0,
    firstHitAt: site.first_hit_at ?? row?.first_at ?? null,
    pages: (pages?.results ?? []).map((p) => ({ value: p.value, visitors: Number(p.visitors) || 0 })),
  };
}

export interface Health {
  /** Estimated hits stored today, and the site's daily limit. */
  storedToday: number;
  dailyCap: number;
  /** Hits refused in the last 7 days, by reason, most first. */
  dropped: { reason: string; n: number }[];
}

export async function health(db: OrgDb, site: Site, now = Date.now()): Promise<Health> {
  const today = localDay(site.timezone, now);
  const rows = await db.all<{ day: string; name: string; n: number }>(
    'SELECT day, name, n FROM an_counters WHERE org_id = :org AND site_id = ? AND day >= ?',
    site.id, addDays(today, -6),
  );
  const dropped = new Map<string, number>();
  let storedToday = 0;
  for (const r of rows) {
    if (r.name === 'hits') {
      if (r.day === today) storedToday = r.n;
    } else if (r.name.startsWith('drop.')) dropped.set(r.name.slice(5), (dropped.get(r.name.slice(5)) ?? 0) + r.n);
  }
  return { storedToday, dailyCap: site.daily_cap, dropped: [...dropped.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n) };
}

export interface PropRow {
  key: string;
  value: string;
  events: number;
  visitors: number;
}

/** The properties sent with one event, most common first. Raw hits only, so inside the retention window. */
export async function eventProps(db: OrgDb, site: Site, range: Range, event: string): Promise<{ items: PropRow[]; blocked: Report['blocked'] }> {
  const blocked = await rawBlock(db, site, range.from, range.to, range.today);
  if (blocked) return { items: [], blocked };
  const [start, end] = rawWindow(site, range.from, range.to);
  const found = await db.d1
    .prepare(
      `SELECT j.key AS key, CAST(j.value AS TEXT) AS value, COUNT(*) AS events, COUNT(DISTINCT h.visitor || h.day) AS visitors
       FROM an_hits h, json_each(h.props) j
       WHERE h.org_id = ?1 AND h.site_id = ?2 AND h.at >= ?3 AND h.at < ?4 AND h.day BETWEEN ?5 AND ?6 AND h.kind = 'e' AND h.name = ?7 AND h.props IS NOT NULL
       GROUP BY j.key, j.value ORDER BY events DESC, key, value LIMIT 200`,
    )
    .bind(db.orgId, site.id, start, end, range.from, range.to, event)
    .all<PropRow>();
  return { items: found.results, blocked: null };
}

export const HIT_COLUMNS = [
  'at', 'id', 'day', 'hour', 'kind', 'name', 'path', 'prev_path', 'visitor', 'source', 'channel', 'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'country', 'region', 'city', 'device', 'browser', 'os', 'props',
] as const;

/** Raw hits, oldest first, a page at a time. The cursor is the last row's time and id. */
export async function rawHits(db: OrgDb, site: Site, opts: { limit?: number; cursor?: string | null } = {}): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 5000));
  const after = unpackCursor(opts.cursor);
  const found = await db.d1
    .prepare(`SELECT ${HIT_COLUMNS.join(', ')} FROM an_hits WHERE org_id = ?1 AND site_id = ?2 AND (at, id) > (?3, ?4) ORDER BY at, id LIMIT ?5`)
    .bind(db.orgId, site.id, Number(after?.at) || 0, String(after?.id ?? ''), limit + 1)
    .all<Record<string, unknown>>();
  const items = found.results.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: found.results.length > limit && last ? packCursor({ at: Number(last.at), id: String(last.id) }) : null };
}

/**
 * The page marker `step` rows further on, or null when no more than `step` rows are left. It lets
 * a screen link to the next part of a raw export without loading the part itself.
 */
export async function hitsCursorAfter(db: OrgDb, site: Site, cursor: string | null | undefined, step: number): Promise<string | null> {
  const after = unpackCursor(cursor);
  const found = await db.d1
    .prepare('SELECT at, id FROM an_hits WHERE org_id = ?1 AND site_id = ?2 AND (at, id) > (?3, ?4) ORDER BY at, id LIMIT 2 OFFSET ?5')
    .bind(db.orgId, site.id, Number(after?.at) || 0, String(after?.id ?? ''), step - 1)
    .all<{ at: number; id: string }>();
  const last = found.results[0];
  return last && found.results.length > 1 ? packCursor({ at: Number(last.at), id: String(last.id) }) : null;
}

export interface SiteCard {
  site: Site;
  visitorsToday: number;
  pageviewsToday: number;
  visitorsYesterday: number;
  /** Visitors per day for the last 7 days, oldest first. */
  spark: number[];
}

/** Today's numbers and a week of history for every site, from the daily totals, in one batch. */
export async function siteCards(db: OrgDb, sites: Site[], now = Date.now()): Promise<SiteCard[]> {
  if (!sites.length) return [];
  const results = await db.d1.batch<{ day: string; visitors: number; pageviews: number }>(
    sites.map((s) => {
      const today = localDay(s.timezone, now);
      return db.d1
        .prepare("SELECT day, visitors, pageviews FROM an_rollups WHERE org_id = ?1 AND site_id = ?2 AND dim = 'total' AND day BETWEEN ?3 AND ?4")
        .bind(db.orgId, s.id, addDays(today, -6), today);
    }),
  );
  return sites.map((site, i) => {
    const today = localDay(site.timezone, now);
    const byDay = new Map((results[i]?.results ?? []).map((r) => [r.day, r]));
    return {
      site,
      visitorsToday: byDay.get(today)?.visitors ?? 0,
      pageviewsToday: byDay.get(today)?.pageviews ?? 0,
      visitorsYesterday: byDay.get(addDays(today, -1))?.visitors ?? 0,
      spark: eachDay(addDays(today, -6), today).map((d) => byDay.get(d)?.visitors ?? 0),
    };
  });
}
