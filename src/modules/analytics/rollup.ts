/**
 * Daily totals. Hits carry what each one added (new visitor, new visit, first view of a page,
 * bounce undone, time), so a total is a plain sum and a rollup is one INSERT ... SELECT that adds
 * the hits since the site's cursor (`rolled_at`) to an_rollups and moves the cursor, in one batch.
 *
 * Why a job and not an upsert per hit. A page view touches about 17 totals (total, hour, page,
 * entry, exit, source, channel, country, device, browser, system and more). Written with the hit
 * that is 2 + 17 rows per page view: 190,000 rows a day at 10,000 page views, past the free
 * plan's 100,000. Rolled up later, rows written depend on how many different values showed up
 * since the last run, not on how many hits: about 200 rows an hour for a typical small site.
 *
 *                              per day at 10,000 hits     per day at 100,000 hits
 *   hit + visitor row          20,000 written             200,000 written
 *   hourly rollup              ~5,000 written             ~15,000 written
 *   pruning hits later         10,000 + ~3,000 visitors   100,000 + ~30,000
 *   rows read by the rollup    10,000 (each hit once)     100,000
 *
 * So 10,000 hits a day costs about 38,000 of the 100,000 daily row writes, and the free plan
 * tops out near 25,000 hits a day. 100,000 hits a day needs the paid plan either way.
 *
 * Exactly once. The INSERT only runs when `rolled_at` still equals the cursor it was planned
 * with, and the UPDATE that moves the cursor is in the same batch, so two runs at once cannot
 * both add the same hits. A hit that commits after a rollup is stored just past the cursor (see
 * ingest.ts) and waits for the next run. Totals are grouped by the hit's own site-local day, so
 * a hit just before midnight that is rolled up after midnight still lands on the right day.
 */
import type { Env } from '../../env';
import type { Site } from './sites';
import { addDays, DAY, HOUR, localDay } from './time';

/** One slice of the hits: which total it feeds, the value it is grouped by, and what it adds. */
export interface DimSpec {
  /** Unique key inside the generated SQL. */
  k: string;
  /** The dimension the row is stored under. Two specs may feed one dimension. */
  dim: string;
  /** SQL for the value. NULL means "this hit does not count here". */
  value: string;
  visitors?: string;
  visits?: string;
  pageviews?: string;
  events?: string;
  unbounces?: string;
  duration?: string;
}

const PV = "(h.kind = 'p')";
const EV = "(h.kind = 'e')";

/** `vis` is the column that marks a hit as a visitor's first: `h.nv` for the day, `h.np` under a page or event filter. */
export function dimSpecs(vis: 'h.nv' | 'h.np' = 'h.nv'): DimSpec[] {
  const full = (k: string, value: string): DimSpec => ({ k, dim: k, value, visitors: vis, visits: 'h.ns', pageviews: PV, events: EV, unbounces: 'h.ub', duration: 'h.dur' });
  return [
    full('total', "''"),
    full('hour', "printf('%02d', h.hour)"),
    full('source', "COALESCE(h.source, 'Direct / None')"),
    full('channel', 'h.channel'),
    full('utm_source', 'h.utm_source'),
    full('utm_medium', 'h.utm_medium'),
    full('utm_campaign', 'h.utm_campaign'),
    full('utm_content', 'h.utm_content'),
    full('utm_term', 'h.utm_term'),
    full('country', "COALESCE(h.country, 'Unknown')"),
    full('device', "COALESCE(h.device, 'other')"),
    full('browser', "COALESCE(h.browser, 'Other')"),
    full('os', "COALESCE(h.os, 'Other')"),
    { k: 'page', dim: 'page', value: `CASE WHEN ${PV} THEN h.path END`, visitors: 'h.np', pageviews: '1' },
    // Time between two hits belongs to the page the visitor was on before the later hit.
    { k: 'pagetime', dim: 'page', value: "CASE WHEN h.dur > 0 THEN CASE WHEN h.kind = 'p' THEN h.prev_path ELSE h.path END END", duration: 'h.dur' },
    { k: 'entry', dim: 'entry', value: 'CASE WHEN h.ns = 1 THEN h.path END', visitors: vis, visits: '1' },
    // A visit stops being a bounce on its second page view (whose previous page is the entry
    // page) or on an event or ping while still on the entry page.
    { k: 'entryub', dim: 'entry', value: 'CASE WHEN h.ub = 1 THEN COALESCE(h.prev_path, h.path) END', unbounces: '1' },
    // Exits: every page view is the last one so far, until a later page view takes that back.
    { k: 'exit', dim: 'exit', value: `CASE WHEN ${PV} THEN h.path END`, visits: '1' },
    { k: 'exitprev', dim: 'exit', value: `CASE WHEN ${PV} THEN h.prev_path END`, visits: '-1' },
    { k: 'event', dim: 'event', value: `CASE WHEN ${EV} THEN h.name END`, visitors: 'h.np', events: '1' },
  ];
}

/** Dimensions that exist only while raw hits are kept: too many values to store per day. */
export function rawOnlySpecs(vis: 'h.nv' | 'h.np'): DimSpec[] {
  const full = (k: string, value: string): DimSpec => ({ k, dim: k, value, visitors: vis, visits: 'h.ns', pageviews: PV, events: EV, unbounces: 'h.ub', duration: 'h.dur' });
  return [
    full('day', 'h.day'),
    full('region', "CASE WHEN h.region IS NOT NULL THEN COALESCE(h.country, '') || ' · ' || h.region END"),
    full('city', "CASE WHEN h.city IS NOT NULL THEN COALESCE(h.country, '') || ' · ' || h.city END"),
  ];
}

export const METRICS = ['visitors', 'visits', 'pageviews', 'events', 'unbounces', 'duration'] as const;
export type MetricName = (typeof METRICS)[number];

/**
 * The shared middle of the rollup and of filtered reads: every hit joined to every slice, grouped
 * by day (optional), dimension and value. CROSS JOIN keeps hits as the outer loop, so each hit is
 * read once however many slices there are.
 */
export function slicedSelect(specs: DimSpec[], opts: { head?: string; where: string; byDay?: boolean }): { cte: string; select: string } {
  const pick = (field: 'dim' | 'value' | MetricName, quote = false): string => {
    const arms = specs.filter((s) => s[field] !== undefined).map((s) => `WHEN '${s.k}' THEN ${quote ? `'${s[field]}'` : s[field]}`);
    return arms.length ? `CASE d.k ${arms.join(' ')} END` : 'NULL';
  };
  const sums = METRICS.map((m) => `COALESCE(SUM(${pick(m)}), 0) AS ${m}`).join(', ');
  return {
    cte: `WITH dims(k) AS (VALUES ${specs.map((s) => `('${s.k}')`).join(', ')})`,
    select: `SELECT ${opts.head ?? ''}${opts.byDay ? 'h.day AS day, ' : ''}${pick('dim', true)} AS dim, ${pick('value')} AS value, ${sums}
    FROM an_hits h CROSS JOIN dims d
    WHERE ${opts.where} AND ${pick('value')} IS NOT NULL
    GROUP BY ${opts.byDay ? 'h.day, ' : ''}dim, value`,
  };
}

// ?1 site  ?2 cursor the run was planned with  ?3 new cursor
const ROLLUP_SQL = (() => {
  const { cte, select } = slicedSelect(dimSpecs(), {
    head: 'h.org_id AS org_id, h.site_id AS site_id, ',
    where: 'h.site_id = ?1 AND h.at > ?2 AND h.at <= ?3 AND EXISTS (SELECT 1 FROM an_sites WHERE id = ?1 AND rolled_at = ?2)',
    byDay: true,
  });
  // INSERT comes first (not WITH) so the statement reports how many rows it changed everywhere.
  return `INSERT INTO an_rollups (org_id, site_id, day, dim, value, ${METRICS.join(', ')})
    ${cte} ${select}
    ON CONFLICT (site_id, dim, day, value) DO UPDATE SET ${METRICS.map((m) => `${m} = ${m} + excluded.${m}`).join(', ')}`;
})();

const MOVE_CURSOR = `UPDATE an_sites SET rolled_at = ?3,
    first_hit_at = COALESCE(first_hit_at, (SELECT MIN(at) FROM an_hits WHERE site_id = ?1))
  WHERE id = ?1 AND rolled_at = ?2`;

/** A backlog is rolled up in steps this long, so one statement never has days of hits to chew through. */
const STEP_MS = 6 * HOUR;
const MAX_STEPS = 8;

export interface RollupResult {
  /** Rows added or changed in an_rollups. */
  written: number;
  rolledAt: number;
}

/**
 * Add every hit since the site's cursor to the daily totals. Safe to call at any time, from
 * anywhere, twice. `stepMs` is only widened for sample data, which is small and arrives all at once.
 */
export async function rollupSite(env: Env, site: Pick<Site, 'id' | 'rolled_at'>, now = Date.now(), stepMs = STEP_MS): Promise<RollupResult> {
  let from = site.rolled_at;
  let written = 0;
  for (let step = 0; step < MAX_STEPS && from < now; step++) {
    // Jump over quiet stretches: a step ends six hours after the oldest hit still waiting, or now.
    const oldest = await env.DB.prepare('SELECT MIN(at) AS at FROM an_hits WHERE site_id = ?1 AND at > ?2').bind(site.id, from).first<{ at: number | null }>();
    const upto = typeof oldest?.at === 'number' ? Math.min(now, oldest.at + stepMs) : now;
    const [added, moved] = await env.DB.batch([env.DB.prepare(ROLLUP_SQL).bind(site.id, from, upto), env.DB.prepare(MOVE_CURSOR).bind(site.id, from, upto)]);
    // Someone else moved the cursor first: their run covered these hits.
    if (!moved?.meta.changes) {
      const current = await env.DB.prepare('SELECT rolled_at FROM an_sites WHERE id = ?1').bind(site.id).first<{ rolled_at: number }>();
      return { written, rolledAt: current?.rolled_at ?? from };
    }
    written += added?.meta.changes ?? 0;
    from = upto;
  }
  return { written, rolledAt: from };
}

/** Roll up when the totals are older than `maxAgeMs`. Returns the site with its new cursor. */
export async function ensureFresh<T extends Pick<Site, 'id' | 'rolled_at'>>(env: Env, site: T, now: number, maxAgeMs: number): Promise<T> {
  if (now - site.rolled_at <= maxAgeMs) return site;
  const { rolledAt } = await rollupSite(env, site, now);
  return { ...site, rolled_at: rolledAt };
}

const PRUNE_CHUNK = 5000;

export interface PruneResult {
  hits: number;
  sessions: number;
  /** True when there is more to delete than one run is allowed to. */
  more: boolean;
}

/**
 * Delete raw hits older than the site's retention window, visitor rows older than two days and
 * counters older than 90 days. Daily totals are kept. Hits not yet rolled up are never deleted.
 */
export async function pruneSite(env: Env, site: Pick<Site, 'id' | 'timezone' | 'retention_days' | 'rolled_at'>, now = Date.now(), maxChunks = 8): Promise<PruneResult> {
  const cutoff = Math.min(now - site.retention_days * DAY, site.rolled_at);
  let hits = 0;
  let more = false;
  for (let i = 0; i < maxChunks; i++) {
    const res = await env.DB.prepare(
      `DELETE FROM an_hits WHERE (site_id, at, id) IN (SELECT site_id, at, id FROM an_hits WHERE site_id = ?1 AND at < ?2 ORDER BY at LIMIT ${PRUNE_CHUNK})`,
    )
      .bind(site.id, cutoff)
      .run();
    const n = res.meta.changes ?? 0;
    hits += n;
    more = n === PRUNE_CHUNK;
    if (!more) break;
  }
  const today = localDay(site.timezone, now);
  const [sessions] = await env.DB.batch([
    env.DB.prepare('DELETE FROM an_sessions WHERE site_id = ?1 AND day < ?2').bind(site.id, addDays(today, -2)),
    env.DB.prepare('DELETE FROM an_counters WHERE site_id = ?1 AND day < ?2').bind(site.id, addDays(today, -90)),
  ]);
  return { hits, sessions: sessions?.meta.changes ?? 0, more };
}

/** Delete what is left of a removed site, a chunk at a time. Returns true when rows remain. */
export async function purgeSite(env: Env, orgId: string, siteId: string, maxChunks = 8): Promise<boolean> {
  const tables: [string, string][] = [
    ['an_hits', 'site_id, at, id'],
    ['an_sessions', 'site_id, visitor, day'],
    ['an_rollups', 'site_id, dim, day, value'],
  ];
  let budget = maxChunks;
  for (const [table, key] of tables) {
    for (;;) {
      if (budget-- <= 0) return true;
      const res = await env.DB.prepare(`DELETE FROM ${table} WHERE (${key}) IN (SELECT ${key} FROM ${table} WHERE site_id = ?1 AND org_id = ?2 LIMIT ${PRUNE_CHUNK})`)
        .bind(siteId, orgId)
        .run();
      if ((res.meta.changes ?? 0) < PRUNE_CHUNK) break;
    }
  }
  return false;
}
