/**
 * Reading click stats. Day totals come from `links_daily` (always exact). Breakdowns and unique
 * visitors come from `links_rollups` for days the nightly rollup has covered, and from the short
 * window of raw clicks for the days after that. Every day in the range is returned, zeros included.
 */
import { getSetting, INSTANCE } from '../../core/settings';
import { addDays, eachDay, resolveRange } from './days';
import { linkErrors } from './errors';
import type { LinksCtx } from './types';
import type { VisitKind } from './record';

export const ROLLED_KEY = 'links.rolled_through';

export const DIMS = ['country', 'city', 'device', 'browser', 'os', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'source'] as const;
export type Dim = (typeof DIMS)[number];

/** SQL that turns a raw column into the value stored in rollups. */
const RAW_VALUE: Record<Dim, string> = {
  country: `COALESCE(NULLIF(country, ''), 'Unknown')`,
  city: `COALESCE(NULLIF(city, ''), 'Unknown')`,
  device: `COALESCE(NULLIF(device, ''), 'Unknown')`,
  browser: `COALESCE(NULLIF(browser, ''), 'Unknown')`,
  os: `COALESCE(NULLIF(os, ''), 'Unknown')`,
  referrer: `COALESCE(NULLIF(referrer, ''), 'Direct')`,
  utm_source: 'utm_source',
  utm_medium: 'utm_medium',
  utm_campaign: 'utm_campaign',
  source: `CASE WHEN qr = 1 THEN 'QR code' ELSE 'Link' END`,
};
const RAW_FILTER: Partial<Record<Dim, string>> = { utm_source: `utm_source <> ''`, utm_medium: `utm_medium <> ''`, utm_campaign: `utm_campaign <> ''` };

export function rawDimSelects(): string {
  return DIMS.map((d) => `SELECT '${d}' AS dim, ${RAW_VALUE[d]} AS value, COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS uniques FROM r${RAW_FILTER[d] ? ` WHERE ${RAW_FILTER[d]}` : ''} GROUP BY 2`).join(' UNION ALL ');
}

export async function rolledThrough(ctx: LinksCtx): Promise<string> {
  return getSetting<string>(ctx.env, INSTANCE, ROLLED_KEY, '');
}

export interface DayStat {
  day: string;
  clicks: number;
  uniques: number;
  bots: number;
  qr: number;
}

export interface Slice {
  value: string;
  clicks: number;
}

export interface Stats {
  from: string;
  to: string;
  days: DayStat[];
  totals: { clicks: number; uniques: number; bots: number; qr: number };
  breakdowns: Record<Dim, Slice[]>;
}

export interface StatsOptions {
  /** One link or bio page. Leave out for the whole workspace. */
  targetId?: string;
  kind?: VisitKind;
  days?: number;
  from?: string;
  to?: string;
  /** How many rows to keep in each breakdown. */
  top?: number;
}

export async function getStats(ctx: LinksCtx, opts: StatsOptions = {}, now = Date.now()): Promise<Stats> {
  const kind = opts.kind ?? 'click';
  const { from, to } = resolveRange(opts, now);
  const rolled = await rolledThrough(ctx);
  const top = opts.top ?? 8;
  const target = opts.targetId ? ' AND target_id = ?' : '';
  const targetParam = opts.targetId ? [opts.targetId] : [];

  // Rolled-up days are [from, min(to, rolled)]; raw days are [max(from, rolled + 1), to].
  const rollTo = rolled && rolled < to ? rolled : to;
  const hasRolled = !!rolled && from <= rollTo;
  const rawFrom = rolled && rolled >= from ? addDays(rolled, 1) : from;
  const hasRaw = rawFrom <= to;

  const { DB } = ctx.env;
  const dailyQ = DB.prepare(`SELECT day, SUM(clicks) AS clicks, SUM(qr) AS qr, SUM(bots) AS bots FROM links_daily WHERE org_id = ? AND kind = ?${target} AND day BETWEEN ? AND ? GROUP BY day`).bind(
    ctx.orgId, kind, ...targetParam, from, to,
  );
  const rollQ = hasRolled
    ? DB.prepare(`SELECT dim, day, value, SUM(clicks) AS clicks, SUM(uniques) AS uniques FROM links_rollups WHERE org_id = ? AND kind = ?${target} AND day BETWEEN ? AND ? GROUP BY dim, day, value`).bind(
        ctx.orgId, kind, ...targetParam, from, rollTo,
      )
    : null;
  const rawQ = hasRaw
    ? DB.prepare(
        `WITH r AS (SELECT * FROM links_clicks WHERE org_id = ? AND kind = ?${target} AND day BETWEEN ? AND ?)
         SELECT 'all' AS dim, day AS value, COUNT(*) AS clicks, COUNT(DISTINCT visitor) AS uniques FROM r GROUP BY day
         UNION ALL ${rawDimSelects()}`,
      ).bind(ctx.orgId, kind, ...targetParam, rawFrom, to)
    : null;
  const batch = await DB.batch([dailyQ, ...(rollQ ? [rollQ] : []), ...(rawQ ? [rawQ] : [])]);
  const dailyRows = batch[0]!.results as { day: string; clicks: number; qr: number; bots: number }[];
  let idx = 1;
  const rollRows = rollQ ? (batch[idx++]!.results as { dim: string; day: string; value: string; clicks: number; uniques: number }[]) : [];
  const rawRows = rawQ ? (batch[idx++]!.results as { dim: string; value: string; clicks: number; uniques: number }[]) : [];

  const uniquesByDay = new Map<string, number>();
  const buckets = new Map<Dim, Map<string, number>>(DIMS.map((d) => [d, new Map()]));
  const bump = (dim: string, value: string, n: number) => {
    const m = buckets.get(dim as Dim);
    if (m) m.set(value, (m.get(value) ?? 0) + n);
  };
  for (const r of rollRows) {
    if (r.dim === 'all') uniquesByDay.set(r.day, (uniquesByDay.get(r.day) ?? 0) + r.uniques);
    else bump(r.dim, r.value, r.clicks);
  }
  for (const r of rawRows) {
    if (r.dim === 'all') uniquesByDay.set(r.value, (uniquesByDay.get(r.value) ?? 0) + r.uniques);
    else bump(r.dim, r.value, r.clicks);
  }

  const byDay = new Map(dailyRows.map((r) => [r.day, r]));
  const days: DayStat[] = eachDay(from, to).map((day) => {
    const d = byDay.get(day);
    return { day, clicks: d?.clicks ?? 0, uniques: uniquesByDay.get(day) ?? 0, bots: d?.bots ?? 0, qr: d?.qr ?? 0 };
  });
  const totals = days.reduce((t, d) => ({ clicks: t.clicks + d.clicks, uniques: t.uniques + d.uniques, bots: t.bots + d.bots, qr: t.qr + d.qr }), { clicks: 0, uniques: 0, bots: 0, qr: 0 });
  const breakdowns = {} as Record<Dim, Slice[]>;
  for (const dim of DIMS) {
    breakdowns[dim] = [...buckets.get(dim)!.entries()].map(([value, clicks]) => ({ value, clicks })).sort((a, b) => b.clicks - a.clicks || a.value.localeCompare(b.value)).slice(0, top);
  }
  return { from, to, days, totals, breakdowns };
}

export interface TopLink {
  id: string;
  code: string;
  title: string;
  url: string;
  clicks: number;
}

/** The links with the most clicks in a range, for the workspace overview. */
export async function topLinks(ctx: LinksCtx, opts: { days?: number; from?: string; to?: string; limit?: number } = {}, now = Date.now()): Promise<TopLink[]> {
  const { from, to } = resolveRange(opts, now);
  const { results } = await ctx.env.DB.prepare(
    `SELECT l.id, l.code, l.title, l.url, SUM(d.clicks) AS clicks
     FROM links_daily d JOIN links_links l ON l.id = d.target_id
     WHERE d.org_id = ?1 AND d.kind = 'click' AND d.day BETWEEN ?2 AND ?3
     GROUP BY l.id HAVING SUM(d.clicks) > 0 ORDER BY clicks DESC, l.id DESC LIMIT ?4`,
  )
    .bind(ctx.orgId, from, to, opts.limit ?? 5)
    .all<TopLink>();
  return results;
}

/** Clicks per bio block over a range, from the block dimension of rollups plus the raw window. */
export async function blockTotals(ctx: LinksCtx, bioId: string, opts: { days?: number; from?: string; to?: string } = {}, now = Date.now()): Promise<Map<string, number>> {
  const { from, to } = resolveRange(opts, now);
  const rolled = await rolledThrough(ctx);
  const rollTo = rolled && rolled < to ? rolled : to;
  const rawFrom = rolled && rolled >= from ? addDays(rolled, 1) : from;
  const queries: D1PreparedStatement[] = [];
  if (rolled && from <= rollTo) {
    queries.push(
      ctx.env.DB.prepare(`SELECT value AS block, SUM(clicks) AS n FROM links_rollups WHERE org_id = ?1 AND target_id = ?2 AND kind = 'block' AND dim = 'block' AND day BETWEEN ?3 AND ?4 GROUP BY value`).bind(ctx.orgId, bioId, from, rollTo),
    );
  }
  if (rawFrom <= to) {
    queries.push(
      ctx.env.DB.prepare(`SELECT block_id AS block, COUNT(*) AS n FROM links_clicks WHERE org_id = ?1 AND target_id = ?2 AND kind = 'block' AND block_id IS NOT NULL AND day BETWEEN ?3 AND ?4 GROUP BY block_id`).bind(ctx.orgId, bioId, rawFrom, to),
    );
  }
  const out = new Map<string, number>();
  if (!queries.length) return out;
  for (const res of await ctx.env.DB.batch(queries)) for (const r of res.results as { block: string; n: number }[]) out.set(r.block, (out.get(r.block) ?? 0) + r.n);
  return out;
}

export function assertTarget(found: boolean): void {
  if (!found) throw linkErrors.not_found();
}
