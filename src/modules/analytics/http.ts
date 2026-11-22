/**
 * Small pieces the API, the dashboard and the public pages all need to turn a request into a
 * question for stats.ts.
 */
import type { Context } from 'hono';
import { orgDb, parseJson } from '../../core/db';
import { errors } from '../../core/errors';
import type { ModuleContext } from '../../core/module';
import type { AppEnv } from '../../env';
import { ensureFresh } from './rollup';
import { analyticsErrors, getSite, snippet, type Site } from './sites';
import { derive, readFilters, resolveRange, type Filters, type Metrics, type Range, type Report } from './stats';
import { MINUTE } from './time';

/** Totals on screen are at most this old. Reading them rolls up first when they are older. */
export const FRESH_MS = MINUTE;

export function ctxOf(c: Context<AppEnv>): ModuleContext {
  const org = c.get('org');
  if (!org) throw errors.unauthorized();
  return { env: c.env, org: { id: org.id, name: org.name, slug: org.slug }, db: orgDb(c.env.DB, org.id) };
}

/** The site named in the path, with totals that include everything up to a minute ago. */
export async function freshSite(ctx: ModuleContext, id: string, now = Date.now()): Promise<Site> {
  const site = await getSite(ctx.db, id);
  return ensureFresh(ctx.env, site, now, FRESH_MS);
}

export function rangeOf(c: Context<AppEnv>, site: Site, now = Date.now()): Range {
  return resolveRange(site, { period: c.req.query('period'), from: c.req.query('from'), to: c.req.query('to') }, now);
}

export function filtersOf(c: Context<AppEnv>): Filters {
  return readFilters((key) => c.req.query(key));
}

/** A filtered view that cannot be shown is an error for the API, and a message on a screen. */
export function throwIfBlocked(blocked: Report['blocked']): void {
  if (blocked === 'expired') throw analyticsErrors.raw_expired();
  if (blocked === 'too_much') throw analyticsErrors.too_much_data();
}

/** Stored sums plus the ratios people read, for API answers and CSV rows. */
export function withRatios<T extends Metrics>(m: T): T & { bounce_rate: number | null; views_per_visit: number | null; visit_seconds: number | null } {
  const d = derive(m);
  const round = (n: number | null, places: number): number | null => (n === null ? null : Math.round(n * 10 ** places) / 10 ** places);
  return { ...m, bounce_rate: round(d.bounceRate, 4), views_per_visit: round(d.viewsPerVisit, 2), visit_seconds: round(d.visitSeconds, 1) };
}

/** A site as the API shows it: lists as lists, switches as true or false, plus the tag to paste. */
export function siteOut(site: Site, appUrl: string): Record<string, unknown> {
  return {
    id: site.id,
    name: site.name,
    domain: site.domain,
    domains: parseJson<string[]>(site.domains, []),
    key: site.key,
    timezone: site.timezone,
    retention_days: site.retention_days,
    engagement: site.engagement === 1,
    respect_dnt: site.respect_dnt === 1,
    daily_cap: site.daily_cap,
    exclude_paths: parseJson<string[]>(site.exclude_paths, []),
    exclude_ips: parseJson<string[]>(site.exclude_ips, []),
    pinned: site.pinned === 1,
    weekly_report: site.weekly_report === 1,
    report_emails: parseJson<string[]>(site.report_emails, []),
    spike_threshold: site.spike_threshold,
    first_hit_at: site.first_hit_at,
    sample: site.sample === 1,
    created_at: site.created_at,
    updated_at: site.updated_at,
    snippet: snippet(appUrl, site),
  };
}

/** `?limit=` as a number inside sensible bounds. */
export function limitOf(c: Context<AppEnv>, fallback: number, max: number): number {
  const n = Math.floor(Number(c.req.query('limit')));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

export function csvResponse(body: string, filename: string): Response {
  return new Response(body, {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '-')}"`, 'cache-control': 'no-store' },
  });
}
