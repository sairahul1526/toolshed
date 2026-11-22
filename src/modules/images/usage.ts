/**
 * Usage: what was drawn, what was served from storage, and what failed.
 *
 * A new image writes one log row and adds to the day's totals. A cache hit is far more common, so
 * it costs a single small write into `img_hits`; an hourly roll-up moves those counts into the
 * totals. Days are UTC.
 */
import type { OrgDb } from '../../core/db';
import { newId } from '../../core/db';
import type { Env } from '../../env';
import { pageOf, type Page } from './templates';

export const LOG_KEEP_DAYS = 30;
export const DAILY_KEEP_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export type RenderSource = 'url' | 'api' | 'batch' | 'bake';

export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface HitInput {
  orgId: string;
  templateId: string;
  hash: string;
  /** True the first time anyone asks for one of the template's images by URL. */
  first: boolean;
}

/** Counts one image served from storage. */
export async function recordHit(env: Env, hit: HitInput, now = Date.now()): Promise<void> {
  const count = env.DB.prepare(
    `INSERT INTO img_hits (org_id, day, hash, template_id, hits) VALUES (?1, ?2, ?3, ?4, 1)
     ON CONFLICT (org_id, day, hash) DO UPDATE SET hits = hits + 1`,
  ).bind(hit.orgId, dayOf(now), hit.hash, hit.templateId);
  if (!hit.first) {
    await count.run();
    return;
  }
  await env.DB.batch([
    count,
    env.DB.prepare('UPDATE img_templates SET first_request_at = ?3 WHERE org_id = ?1 AND id = ?2 AND first_request_at IS NULL').bind(hit.orgId, hit.templateId, now),
  ]);
}

export interface RenderInput {
  orgId: string;
  templateId: string;
  hash: string;
  format: string;
  width: number;
  version: number;
  /** The parameters that made the image, as a query string without the signature. */
  query: string;
  bytes: number;
  source: RenderSource;
  ms: number;
}

/** Records one new image: the cache index row, the template's count, the day's totals and a log line. */
export async function recordRender(env: Env, r: RenderInput, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO img_renders (id, org_id, template_id, hash, format, width, version, query, bytes, source, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT (hash) DO UPDATE SET bytes = excluded.bytes, source = excluded.source`,
    ).bind(newId('imgr', now), r.orgId, r.templateId, r.hash, r.format, r.width, r.version, r.query.slice(0, 500), r.bytes, r.source, now),
    env.DB.prepare(
      `UPDATE img_templates SET renders = renders + 1,
         first_request_at = CASE WHEN ?4 = 'url' THEN COALESCE(first_request_at, ?3) ELSE first_request_at END
       WHERE org_id = ?1 AND id = ?2`,
    ).bind(r.orgId, r.templateId, now, r.source),
    env.DB.prepare(
      `INSERT INTO img_daily (org_id, day, template_id, renders, bytes) VALUES (?1, ?2, ?3, 1, ?4)
       ON CONFLICT (org_id, day, template_id) DO UPDATE SET renders = renders + 1, bytes = bytes + excluded.bytes`,
    ).bind(r.orgId, dayOf(now), r.templateId, r.bytes),
    env.DB.prepare(
      `INSERT INTO img_log (id, org_id, template_id, outcome, format, source, ms, bytes, created_at)
       VALUES (?1, ?2, ?3, 'rendered', ?4, ?5, ?6, ?7, ?8)`,
    ).bind(newId('imgl', now), r.orgId, r.templateId, r.format, r.source, Math.round(r.ms), r.bytes, now),
  ]);
}

export interface FailureInput {
  orgId: string;
  templateId: string;
  format: string;
  source: RenderSource;
  code: string;
  detail: string;
}

/** Records an image that could not be drawn. */
export async function recordFailure(env: Env, f: FailureInput, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO img_log (id, org_id, template_id, outcome, format, source, code, detail, created_at)
       VALUES (?1, ?2, ?3, 'error', ?4, ?5, ?6, ?7, ?8)`,
    ).bind(newId('imgl', now), f.orgId, f.templateId, f.format, f.source, f.code, f.detail.slice(0, 300), now),
    env.DB.prepare(
      `INSERT INTO img_daily (org_id, day, template_id, errors) VALUES (?1, ?2, ?3, 1)
       ON CONFLICT (org_id, day, template_id) DO UPDATE SET errors = errors + 1`,
    ).bind(f.orgId, dayOf(now), f.templateId),
  ]);
}

/** New images the workspace has made so far today (UTC). */
export async function rendersToday(db: OrgDb, now = Date.now()): Promise<number> {
  const row = await db.first<{ n: number }>('SELECT COALESCE(SUM(renders), 0) AS n FROM img_daily WHERE org_id = :org AND day = ?', dayOf(now));
  return row?.n ?? 0;
}

/**
 * Moves the cache hits counted since the last run into the daily totals and onto each image, for
 * every workspace at once. One transaction, so a hit is never counted twice or lost.
 */
export async function rollupHits(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO img_daily (org_id, day, template_id, hits)
       SELECT org_id, day, template_id, SUM(hits) FROM img_hits WHERE true GROUP BY org_id, day, template_id
       ON CONFLICT (org_id, day, template_id) DO UPDATE SET hits = img_daily.hits + excluded.hits`,
    ),
    env.DB.prepare(
      `UPDATE img_renders SET hits = hits + (SELECT SUM(h.hits) FROM img_hits h WHERE h.hash = img_renders.hash), last_hit_at = ?1
       WHERE hash IN (SELECT hash FROM img_hits)`,
    ).bind(now),
    env.DB.prepare('DELETE FROM img_hits'),
  ]);
}

/** Deletes log lines and daily totals older than the module keeps them. */
export async function pruneUsage(env: Env, now = Date.now()): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM img_log WHERE created_at < ?1').bind(now - LOG_KEEP_DAYS * DAY_MS),
    env.DB.prepare('DELETE FROM img_daily WHERE day < ?1').bind(dayOf(now - DAILY_KEEP_DAYS * DAY_MS)),
  ]);
}

export interface UsageDay {
  day: string;
  /** New images drawn or uploaded. */
  renders: number;
  /** Images served from storage. */
  hits: number;
  errors: number;
  /** Bytes of the new images. */
  bytes: number;
}

export interface UsageSummary {
  /** Oldest first, one entry per day, zeros included. */
  days: UsageDay[];
  totals: Omit<UsageDay, 'day'>;
  today: number;
}

/** Totals for the last `days` days (today included), for the workspace or one template. */
export async function usageSummary(db: OrgDb, opts: { days?: number; templateId?: string; now?: number } = {}): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const days = Math.min(DAILY_KEEP_DAYS, Math.max(1, Math.floor(opts.days ?? 30)));
  const since = dayOf(now - (days - 1) * DAY_MS);
  const one = opts.templateId ? ' AND template_id = ?' : '';
  const extra = opts.templateId ? [opts.templateId] : [];
  const [rolled, live] = await Promise.all([
    db.all<UsageDay>(
      `SELECT day, SUM(renders) AS renders, SUM(hits) AS hits, SUM(errors) AS errors, SUM(bytes) AS bytes
       FROM img_daily WHERE org_id = :org AND day >= ?${one} GROUP BY day`,
      since,
      ...extra,
    ),
    db.all<{ day: string; hits: number }>(`SELECT day, SUM(hits) AS hits FROM img_hits WHERE org_id = :org AND day >= ?${one} GROUP BY day`, since, ...extra),
  ]);
  const byDay = new Map<string, UsageDay>();
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * DAY_MS);
    byDay.set(day, { day, renders: 0, hits: 0, errors: 0, bytes: 0 });
  }
  for (const row of rolled) {
    const entry = byDay.get(row.day);
    if (entry) Object.assign(entry, row);
  }
  for (const row of live) {
    const entry = byDay.get(row.day);
    if (entry) entry.hits += row.hits;
  }
  const list = [...byDay.values()];
  const totals = { renders: 0, hits: 0, errors: 0, bytes: 0 };
  for (const d of list) {
    totals.renders += d.renders;
    totals.hits += d.hits;
    totals.errors += d.errors;
    totals.bytes += d.bytes;
  }
  return { days: list, totals, today: byDay.get(dayOf(now))?.renders ?? 0 };
}

export interface TopImage {
  id: string;
  templateId: string;
  format: string;
  width: number;
  query: string;
  bytes: number;
  source: RenderSource;
  /** Counted up to the last hourly roll-up. */
  hits: number;
  createdAt: number;
  lastHitAt: number | null;
}

interface RenderRow {
  id: string;
  template_id: string;
  format: string;
  width: number;
  query: string;
  bytes: number;
  source: RenderSource;
  hits: number;
  created_at: number;
  last_hit_at: number | null;
}

/** The stored images asked for most often. */
export async function topImages(db: OrgDb, limit = 10): Promise<TopImage[]> {
  const rows = await db.all<RenderRow>('SELECT * FROM img_renders WHERE org_id = :org ORDER BY hits DESC, id DESC LIMIT ?', Math.min(50, Math.max(1, limit)));
  return rows.map((r) => ({
    id: r.id,
    templateId: r.template_id,
    format: r.format,
    width: r.width,
    query: r.query,
    bytes: r.bytes,
    source: r.source,
    hits: r.hits,
    createdAt: r.created_at,
    lastHitAt: r.last_hit_at,
  }));
}

export interface LogEntry {
  id: string;
  templateId: string | null;
  outcome: 'rendered' | 'error';
  format: string | null;
  source: RenderSource;
  ms: number | null;
  bytes: number | null;
  code: string | null;
  detail: string | null;
  at: number;
}

interface LogRow {
  id: string;
  template_id: string | null;
  outcome: 'rendered' | 'error';
  format: string | null;
  source: RenderSource;
  ms: number | null;
  bytes: number | null;
  code: string | null;
  detail: string | null;
  created_at: number;
}

/** New images and failures, newest first. Cache hits are counted, not listed. */
export async function listLog(db: OrgDb, opts: { limit?: number; cursor?: string | null; errorsOnly?: boolean } = {}): Promise<Page<LogEntry>> {
  const page = await pageOf<LogRow>(db, 'img_log', { limit: opts.limit, cursor: opts.cursor, and: opts.errorsOnly ? `outcome = 'error'` : undefined });
  return {
    items: page.items.map((r) => ({
      id: r.id,
      templateId: r.template_id,
      outcome: r.outcome,
      format: r.format,
      source: r.source,
      ms: r.ms,
      bytes: r.bytes,
      code: r.code,
      detail: r.detail,
      at: r.created_at,
    })),
    nextCursor: page.nextCursor,
  };
}
