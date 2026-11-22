/**
 * The scheduled jobs. `rollup` folds each finished day of raw clicks into `links_rollups` (kept
 * long term) and trims raw clicks older than a week. `expire` finds links that have passed their
 * end time and emits `link.expired` once for each.
 */
import { emit } from '../../core/events';
import { getSetting, INSTANCE, setSetting } from '../../core/settings';
import type { Env } from '../../env';
import { addDays, dayOf, DAY_MS } from './days';
import { ROLLED_KEY, DIMS } from './stats';

export const RAW_KEEP_DAYS = 7;
export const ROLLUP_KEEP_DAYS = 400;
const MAX_DAYS_PER_RUN = 31;

const VALUE: Record<string, string> = {
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
const FILTER: Record<string, string> = { utm_source: `AND utm_source <> ''`, utm_medium: `AND utm_medium <> ''`, utm_campaign: `AND utm_campaign <> ''` };

function dayStatements(env: Env, day: string): D1PreparedStatement[] {
  const insert = (dim: string, value: string, extra = '') =>
    env.DB.prepare(
      `INSERT INTO links_rollups (org_id, target_id, kind, day, dim, value, clicks, uniques)
       SELECT org_id, target_id, kind, day, '${dim}', ${value}, COUNT(*), COUNT(DISTINCT visitor)
       FROM links_clicks WHERE day = ?1 ${extra} GROUP BY org_id, target_id, kind, day, 6`,
    ).bind(day);
  return [
    env.DB.prepare('DELETE FROM links_rollups WHERE day = ?1').bind(day),
    insert('all', `''`),
    ...DIMS.map((d) => insert(d, VALUE[d]!, FILTER[d] ?? '')),
    insert('block', 'block_id', `AND kind = 'block' AND block_id IS NOT NULL`),
  ];
}

/** Roll up every finished day that has not been rolled up yet (at most 31 per run). Safe to run again. */
export async function runRollup(env: Env, now = Date.now()): Promise<{ days: number; through: string }> {
  const yesterday = dayOf(now - DAY_MS);
  let through = await getSetting<string>(env, INSTANCE, ROLLED_KEY, '');
  let day: string;
  if (through) {
    day = addDays(through, 1);
  } else {
    const first = await env.DB.prepare('SELECT MIN(day) AS d FROM links_clicks').first<{ d: string | null }>();
    if (!first?.d) {
      await setSetting(env, INSTANCE, ROLLED_KEY, yesterday);
      return { days: 0, through: yesterday };
    }
    day = first.d;
  }
  let done = 0;
  while (day <= yesterday && done < MAX_DAYS_PER_RUN) {
    await env.DB.batch(dayStatements(env, day));
    through = day;
    await setSetting(env, INSTANCE, ROLLED_KEY, through);
    day = addDays(day, 1);
    done++;
  }
  if (through) {
    await env.DB.prepare('DELETE FROM links_clicks WHERE day < ?1').bind(addDays(through, -(RAW_KEEP_DAYS - 1))).run();
    await env.DB.prepare('DELETE FROM links_rollups WHERE day < ?1').bind(addDays(yesterday, -ROLLUP_KEEP_DAYS)).run();
  }
  return { days: done, through };
}

/** Emit `link.expired` for active links past their end time, once each. */
export async function runExpire(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare(
    `SELECT id, org_id, code, expires_at FROM links_links WHERE expires_at IS NOT NULL AND expires_at <= ?1 AND expired_notified = 0 AND status = 'active' LIMIT 200`,
  )
    .bind(now)
    .all<{ id: string; org_id: string; code: string; expires_at: number }>();
  for (const r of results) {
    const res = await env.DB.prepare('UPDATE links_links SET expired_notified = 1 WHERE id = ?1 AND expired_notified = 0').bind(r.id).run();
    if (res.meta.changes) await emit(env, { orgId: r.org_id, module: 'links', name: 'link.expired', subject: r.id, at: r.expires_at, data: { code: r.code, reason: 'end_time' } });
  }
  return results.length;
}

/** Said once when a link reaches its click cap. Returns whether this call was the first to notice. */
export async function noteCapReached(env: Env, link: { id: string; org_id: string; code: string }): Promise<boolean> {
  const res = await env.DB.prepare('UPDATE links_links SET expired_notified = 1 WHERE id = ?1 AND expired_notified = 0').bind(link.id).run();
  if (!res.meta.changes) return false;
  await emit(env, { orgId: link.org_id, module: 'links', name: 'link.expired', subject: link.id, data: { code: link.code, reason: 'click_cap' } });
  return true;
}
