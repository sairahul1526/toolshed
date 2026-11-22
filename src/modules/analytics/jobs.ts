/**
 * Background work: the hourly pass (roll up, goals, spikes, weekly reports), the daily prune,
 * and cleaning up after a deleted site.
 *
 * A Worker run may make about 50 database calls, so no job walks every site in one go. Each run
 * takes a few sites in id order and queues the next run with the id it stopped at.
 */
import { z } from 'zod';
import { orgDb } from '../../core/db';
import { sendEmail } from '../../core/email';
import { emit } from '../../core/events';
import { enqueue, once } from '../../core/jobs';
import { notify } from '../../core/notifications';
import { moduleState } from '../../core/registry';
import type { Env } from '../../env';
import { spikeEmail, weeklyReportEmail } from './emails';
import { pruneSite, purgeSite, rollupSite } from './rollup';
import type { Goal, Site } from './sites';
import { live, report, resolveRange } from './stats';
import { addDays, HOUR, localTime } from './time';

/** Sites looked after per run. A quiet site costs three or four database calls. */
const SITES_PER_RUN = 6;
/** Goals that may send `goal.completed` for one site in one hour. The rest wait for the next hour. */
const GOAL_EVENTS_PER_RUN = 5;
export const SPIKE_QUIET_MS = 12 * HOUR;
/** Reports go out on Monday, once it is this hour in the site's time zone. */
const REPORT_HOUR = 8;
/** Runs in a row one site may take to catch up before the pass moves on. */
const MAX_CATCH_UP = 30;

/** The next sites in id order, across every workspace. Sample sites have nothing coming in, so the hourly pass skips them. */
async function nextSites(env: Env, after: string, limit: number, withSamples: boolean): Promise<Site[]> {
  const found = await env.DB.prepare(`SELECT * FROM an_sites WHERE id > ?1 ${withSamples ? '' : 'AND sample = 0'} ORDER BY id LIMIT ?2`)
    .bind(after, limit)
    .all<Site>();
  return found.results;
}

function parseList(json: string): string[] {
  try {
    const v: unknown = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Null when the install has no fixed address: the email then goes out without a button. */
function dashboardLink(env: Env, site: Pick<Site, 'id'>, query = ''): string | null {
  return env.APP_URL ? `${env.APP_URL.replace(/\/+$/, '')}/app/analytics/sites/${site.id}${query}` : null;
}

// ---------------------------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------------------------

/**
 * Send `goal.completed` for goals that were reached since the last look. One event per goal per
 * hour at most, carrying how many completions it stands for, so a busy goal cannot flood.
 * Returns how many events went out.
 */
export async function emitGoals(env: Env, site: Site, now = Date.now()): Promise<number> {
  const db = orgDb(env.DB, site.org_id);
  const goals = await db.all<Goal>('SELECT * FROM an_goals WHERE org_id = :org AND site_id = ? ORDER BY id LIMIT 100', site.id);
  if (!goals.length) return 0;
  const today = localTime(site.timezone, now).day;
  const counts = await env.DB.batch<{ day: string; n: number | null; visitors: number | null }>(
    goals.map((g) => {
      const like = g.kind === 'page' && g.match.includes('*');
      const value = like ? g.match.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '%') : g.match;
      return env.DB.prepare(
        `SELECT day, SUM(pageviews + events) AS n, SUM(visitors) AS visitors FROM an_rollups
         WHERE site_id = ?1 AND dim = ?2 AND day IN (?3, ?4) AND ${like ? "value LIKE ?5 ESCAPE '\\'" : 'value = ?5'} GROUP BY day`,
      ).bind(site.id, g.kind, g.emitted_day ?? today, today, value);
    }),
  );
  // Start at a different goal each hour, so the same few are not always first in line.
  const shift = Math.floor(now / HOUR) % goals.length;
  let sent = 0;
  const resets: D1PreparedStatement[] = [];
  for (let i = 0; i < goals.length && sent < GOAL_EVENTS_PER_RUN; i++) {
    const at = (i + shift) % goals.length;
    const goal = goals[at]!;
    const rows = counts[at]?.results ?? [];
    const todayRow = rows.find((r) => r.day === today);
    const todayCount = Number(todayRow?.n) || 0;
    let added = todayCount;
    if (goal.emitted_day === today) added -= goal.emitted_count;
    // The first look after midnight also picks up what the day before gained after its last look.
    else if (goal.emitted_day) added += Math.max(0, (Number(rows.find((r) => r.day === goal.emitted_day)?.n) || 0) - goal.emitted_count);
    if (added <= 0) {
      // Nothing new, but the day changed: move the mark along so tomorrow starts from the right place.
      if (goal.emitted_day && goal.emitted_day !== today) {
        resets.push(env.DB.prepare('UPDATE an_goals SET emitted_day = ?3, emitted_count = ?4 WHERE id = ?1 AND org_id = ?2').bind(goal.id, site.org_id, today, todayCount));
      }
      continue;
    }
    // Claim first: when two runs overlap, only the one whose update lands sends the event.
    const claimed = await env.DB.prepare(
      `UPDATE an_goals SET emitted_day = ?3, emitted_count = ?4 WHERE id = ?1 AND org_id = ?2 AND emitted_day IS ?5 AND emitted_count = ?6`,
    )
      .bind(goal.id, site.org_id, today, todayCount, goal.emitted_day, goal.emitted_count)
      .run();
    if (!claimed.meta.changes) continue;
    await emit(env, {
      orgId: site.org_id,
      module: 'analytics',
      name: 'goal.completed',
      subject: goal.id,
      count: added,
      at: now,
      data: { siteId: site.id, domain: site.domain, goal: goal.name, kind: goal.kind, match: goal.match, completions: added, day: today, dayTotal: todayCount },
    });
    sent++;
  }
  if (resets.length) await env.DB.batch(resets);
  return sent;
}

// ---------------------------------------------------------------------------------------------
// Traffic spikes
// ---------------------------------------------------------------------------------------------

/** Tell the workspace when the last hour had more visitors than the site's threshold. At most once every 12 hours. */
export async function checkSpike(env: Env, site: Site, now = Date.now()): Promise<boolean> {
  if (site.spike_threshold <= 0) return false;
  if (site.last_spike_at !== null && now - site.last_spike_at < SPIKE_QUIET_MS) return false;
  const row = await env.DB.prepare('SELECT COUNT(DISTINCT visitor) AS n FROM an_hits WHERE site_id = ?1 AND at > ?2').bind(site.id, now - HOUR).first<{ n: number }>();
  const visitors = Number(row?.n) || 0;
  if (visitors <= site.spike_threshold) return false;
  const claimed = await env.DB.prepare('UPDATE an_sites SET last_spike_at = ?2 WHERE id = ?1 AND (last_spike_at IS NULL OR last_spike_at <= ?3)')
    .bind(site.id, now, now - SPIKE_QUIET_MS)
    .run();
  if (!claimed.meta.changes) return false;
  if (!(await moduleState(env, site.org_id, 'analytics')).enabled) return false;

  await emit(env, {
    orgId: site.org_id,
    module: 'analytics',
    name: 'traffic.spike',
    subject: site.id,
    at: now,
    data: { siteId: site.id, domain: site.domain, visitors, threshold: site.spike_threshold },
  });
  await notify(env, {
    orgId: site.org_id,
    kind: 'analytics',
    title: `Traffic spike on ${site.name}`.slice(0, 120),
    body: `${visitors} visitors in the last hour.`,
    href: `/app/analytics/sites/${site.id}`,
    dedupeKey: `analytics.spike:${site.id}:${now}`,
  });
  const to = parseList(site.report_emails);
  if (to.length) await enqueue(env, 'analytics.alert', { orgId: site.org_id, siteId: site.id, visitors, index: 0 });
  return true;
}

const alertPayload = z.object({ orgId: z.string(), siteId: z.string(), visitors: z.number(), index: z.number().int().min(0) });

/** Email one person about a spike, then queue the next. One address per run keeps each run small. */
export async function alertJob(env: Env, raw: unknown, now = Date.now()): Promise<void> {
  const p = alertPayload.parse(raw);
  const db = orgDb(env.DB, p.orgId);
  const site = await db.get<Site>('an_sites', p.siteId);
  if (!site) return;
  const list = parseList(site.report_emails);
  const to = list[p.index];
  if (!to) return;
  const current = await live(db, site, now, true);
  const email = await spikeEmail(env, {
    orgId: p.orgId,
    site,
    visitors: p.visitors,
    threshold: site.spike_threshold,
    pages: current.pages.slice(0, 5),
    link: dashboardLink(env, site),
  });
  await once(env, `analytics.alert:${site.id}:${site.last_spike_at}:${p.index}`, 86_400, () =>
    sendEmail(env, { orgId: p.orgId, to, ...email, template: 'notification', tag: 'analytics.spike' }),
  );
  if (p.index + 1 < list.length) await enqueue(env, 'analytics.alert', { ...p, index: p.index + 1 });
}

// ---------------------------------------------------------------------------------------------
// Weekly report
// ---------------------------------------------------------------------------------------------

/** The Monday a report is due for, as a site-local day, or null when it is not time yet. */
export function reportKey(site: Pick<Site, 'timezone'>, now: number): string | null {
  const local = localTime(site.timezone, now);
  // Any day of the week works, so a pass that was missed on Monday still sends on Tuesday.
  const monday = addDays(local.day, -((local.weekday + 6) % 7));
  return local.day === monday && local.hour < REPORT_HOUR ? null : monday;
}

/** Queue this week's report when it is due and has not been queued yet. */
export async function triggerReport(env: Env, site: Site, now = Date.now()): Promise<boolean> {
  if (!site.weekly_report) return false;
  const key = reportKey(site, now);
  if (!key || site.last_report_key === key) return false;
  const claimed = await env.DB.prepare('UPDATE an_sites SET last_report_key = ?2 WHERE id = ?1 AND last_report_key IS NOT ?2').bind(site.id, key).run();
  if (!claimed.meta.changes) return false;
  // A site that turns reports on mid-week starts with next Monday's, not one about a week it was not watched.
  if (site.last_report_key === null && localTime(site.timezone, now).day !== key) return false;
  await enqueue(env, 'analytics.report', { orgId: site.org_id, siteId: site.id, key, index: 0, sent: 0 });
  return true;
}

const reportPayload = z.object({ orgId: z.string(), siteId: z.string(), key: z.string(), index: z.number().int().min(0), sent: z.number().int().min(0) });

/** Email the week before `key` to one address, then queue the next. After the last one, say `report.sent`. */
export async function reportJob(env: Env, raw: unknown, now = Date.now()): Promise<void> {
  const p = reportPayload.parse(raw);
  const db = orgDb(env.DB, p.orgId);
  const site = await db.get<Site>('an_sites', p.siteId);
  if (!site || !site.weekly_report) return;
  if (!(await moduleState(env, p.orgId, 'analytics')).enabled) return;
  const list = parseList(site.report_emails);
  const to = list[p.index];
  let sent = p.sent;
  if (to) {
    const from = addDays(p.key, -7);
    const upto = addDays(p.key, -1);
    const range = resolveRange(site, { period: 'custom', from, to: upto }, now);
    const week = await report(db, site, range, {}, { compare: true, dims: ['page', 'source'], limit: 5 });
    const link = dashboardLink(env, site, `?from=${from}&to=${upto}`);
    const email = await weeklyReportEmail(env, {
      orgId: p.orgId,
      site,
      rangeLabel: range.label,
      totals: week.totals,
      prev: week.prev,
      pages: week.panels.page ?? [],
      sources: week.panels.source ?? [],
      link,
    });
    const res = await once(env, `analytics.report:${site.id}:${p.key}:${p.index}`, 6 * 86_400, () =>
      sendEmail(env, { orgId: p.orgId, to, ...email, template: 'notification', tag: 'analytics.report' }),
    );
    if (res.ran && (res.value.status === 'sent' || res.value.status === 'dev')) sent++;
  }
  if (p.index + 1 < list.length) {
    await enqueue(env, 'analytics.report', { ...p, index: p.index + 1, sent });
    return;
  }
  if (sent > 0) {
    await emit(env, { orgId: p.orgId, module: 'analytics', name: 'report.sent', subject: site.id, at: now, data: { siteId: site.id, domain: site.domain, week: p.key, recipients: sent } });
  }
}

// ---------------------------------------------------------------------------------------------
// The hourly pass
// ---------------------------------------------------------------------------------------------

async function tendSite(env: Env, site: Site, now: number): Promise<'done' | 'behind' | 'busy'> {
  const { rolledAt } = await rollupSite(env, site, now);
  if (rolledAt < now) return 'behind';
  const sentGoals = await emitGoals(env, site, now);
  const spiked = await checkSpike(env, site, now);
  const reported = await triggerReport(env, site, now);
  return sentGoals > 0 || spiked || reported ? 'busy' : 'done';
}

const passPayload = z.object({ after: z.string().optional(), again: z.number().int().optional() });

/** Look after the next few sites, then queue a run for the ones after them. */
export async function hourlyJob(env: Env, raw: unknown, now = Date.now()): Promise<void> {
  const p = passPayload.parse(raw ?? {});
  let after = p.after ?? '';
  const again = p.again ?? 0;
  const sites = await nextSites(env, after, SITES_PER_RUN + 1, false);
  for (const [i, site] of sites.slice(0, SITES_PER_RUN).entries()) {
    const state = await tendSite(env, site, now);
    if (state === 'behind' && again < MAX_CATCH_UP) {
      // A long backlog (the job was off for days) is worked through 48 hours a run. Come back to this site.
      await enqueue(env, 'analytics.hourly', { after, again: again + 1 });
      return;
    }
    after = site.id;
    // A site that sent events or email used up its share of this run's database calls.
    if (state === 'busy' && i < sites.length - 1) {
      await enqueue(env, 'analytics.hourly', { after });
      return;
    }
  }
  if (sites.length > SITES_PER_RUN) await enqueue(env, 'analytics.hourly', { after });
}

// ---------------------------------------------------------------------------------------------
// Pruning and purging
// ---------------------------------------------------------------------------------------------

const PRUNE_SITES_PER_RUN = 3;

/** Delete raw hits past each site's retention window. Daily totals stay. */
export async function pruneJob(env: Env, raw: unknown, now = Date.now()): Promise<void> {
  const p = passPayload.parse(raw ?? {});
  let after = p.after ?? '';
  const sites = await nextSites(env, after, PRUNE_SITES_PER_RUN + 1, true);
  for (const site of sites.slice(0, PRUNE_SITES_PER_RUN)) {
    const res = await pruneSite(env, site, now, 6);
    if (res.more) {
      await enqueue(env, 'analytics.prune', { after });
      return;
    }
    after = site.id;
  }
  if (sites.length > PRUNE_SITES_PER_RUN) await enqueue(env, 'analytics.prune', { after });
}

const purgePayload = z.object({ orgId: z.string(), siteId: z.string() });

/** Delete the hits and totals of a site that was removed, a chunk at a time. */
export async function purgeJob(env: Env, raw: unknown): Promise<void> {
  const p = purgePayload.parse(raw);
  if (await purgeSite(env, p.orgId, p.siteId)) await enqueue(env, 'analytics.purge', p);
}
