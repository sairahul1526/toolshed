/**
 * REST API for analytics, mounted at /api/v1/analytics. Reading needs `analytics:read`, changing
 * anything or sending events needs `analytics:write`.
 *
 *   GET    /sites                               every site
 *   POST   /sites                               add a site
 *   GET    /sites/:id                           one site, with its snippet
 *   PATCH  /sites/:id                           change settings
 *   DELETE /sites/:id                           delete the site and its data (admins)
 *   GET    /overview                            today's numbers for every site
 *
 * Stats API. All take ?period= or ?from=&to= (site-local days) and any filter (?page=, ?source=,
 * ?country=, ?goal=, and so on):
 *   GET    /sites/:id/stats                     totals, and ?compare=1 for the period before
 *   GET    /sites/:id/timeseries                visitors and page views per hour, day or month
 *   GET    /sites/:id/breakdown/:dim            top pages, sources, countries (?limit=&cursor=, ?format=csv)
 *   GET    /sites/:id/conversions               every goal with its conversion rate
 *   GET    /sites/:id/events/:name/props        the properties sent with one custom event
 *   GET    /sites/:id/live                      visitors in the last five minutes
 *   GET    /sites/:id/health                    hits stored today and hits refused, by reason
 *   GET    /sites/:id/hits                      raw hits, oldest first (?limit=&cursor=, ?format=csv)
 *
 * Events API:
 *   POST   /sites/:id/events                    record a page view or event from your own server
 *
 *   GET    /sites/:id/goals      POST           DELETE /sites/:id/goals/:goalId
 *   GET    /sites/:id/shares     POST           DELETE /sites/:id/shares/:shareId
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { toCsv } from '../../core/csv';
import { errors, parse, readJson } from '../../core/errors';
import { needRole, requireScope } from '../../core/guards';
import { baseUrl } from '../../core/net';
import type { AppEnv } from '../../env';
import { csvResponse, ctxOf, filtersOf, freshSite, limitOf, rangeOf, siteOut, throwIfBlocked, withRatios } from './http';
import { collect, flushDrops, forgetSites } from './ingest';
import { createGoal, createShare, createSite, deleteGoal, deleteShare, deleteSite, getSite, listGoals, listShares, listSites, publicShare, updateSite } from './sites';
import { breakdown, eventProps, health, HIT_COLUMNS, isDim, live, rawHits, report, siteCards } from './stats';

const READ = requireScope('analytics:read');
const WRITE = requireScope('analytics:write');

const api = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------------------------

api.get('/sites', READ, async (c) => {
  const sites = await listSites(ctxOf(c).db);
  // A workspace holds at most 50 sites, so the list is always one page.
  return c.json({ items: sites.map((s) => siteOut(s, baseUrl(c))), nextCursor: null });
});

api.post('/sites', WRITE, async (c) => {
  const site = await createSite(ctxOf(c), await readJson(c));
  await auditFromRequest(c, { action: 'site.created', targetType: 'site', targetId: site.id, summary: `Added the site ${site.domain}` });
  return c.json(siteOut(site, baseUrl(c)), 201);
});

api.get('/overview', READ, async (c) => {
  const ctx = ctxOf(c);
  const cards = await siteCards(ctx.db, await listSites(ctx.db));
  return c.json({
    items: cards.map((card) => ({
      site: { id: card.site.id, name: card.site.name, domain: card.site.domain, sample: card.site.sample === 1 },
      visitors_today: card.visitorsToday,
      pageviews_today: card.pageviewsToday,
      visitors_yesterday: card.visitorsYesterday,
      visitors_last_7_days: card.spark,
    })),
    nextCursor: null,
  });
});

api.get('/sites/:id', READ, async (c) => c.json(siteOut(await getSite(ctxOf(c).db, c.req.param('id')), baseUrl(c))));

api.patch('/sites/:id', WRITE, async (c) => {
  const site = await updateSite(ctxOf(c), c.req.param('id'), await readJson(c));
  forgetSites(c.env);
  await auditFromRequest(c, { action: 'site.updated', targetType: 'site', targetId: site.id, summary: `Changed settings for ${site.domain}` });
  return c.json(siteOut(site, baseUrl(c)));
});

api.delete('/sites/:id', WRITE, async (c) => {
  needRole(c, 'admin');
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  await deleteSite(ctx, site.id);
  forgetSites(c.env);
  await auditFromRequest(c, { action: 'site.deleted', targetType: 'site', targetId: site.id, summary: `Deleted the site ${site.domain} and its data` });
  return c.json({ deleted: true });
});

// ---------------------------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------------------------

api.get('/sites/:id/stats', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await freshSite(ctx, c.req.param('id'));
  const range = rangeOf(c, site);
  const res = await report(ctx.db, site, range, filtersOf(c), { compare: c.req.query('compare') === '1', dims: [], goals: await listGoals(ctx.db, site.id) });
  throwIfBlocked(res.blocked);
  return c.json({
    range: { period: range.period, from: range.from, to: range.to, timezone: site.timezone },
    filters: res.filters,
    // 'raw' means the answer was counted from single hits, which only exist inside the retention window.
    mode: res.mode,
    // True under a page or event filter: visits, bounce rate and time no longer describe whole visits.
    partial: res.partial,
    totals: withRatios(res.totals),
    previous: res.prev ? { from: range.prevFrom, to: range.prevTo, ...withRatios(res.prev) } : null,
  });
});

api.get('/sites/:id/timeseries', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await freshSite(ctx, c.req.param('id'));
  const range = rangeOf(c, site);
  const res = await report(ctx.db, site, range, filtersOf(c), { compare: c.req.query('compare') === '1', dims: [], goals: await listGoals(ctx.db, site.id) });
  throwIfBlocked(res.blocked);
  const items = res.series.labels.map((label, i) => ({
    label,
    visitors: res.series.visitors[i] ?? 0,
    pageviews: res.series.pageviews[i] ?? 0,
    ...(res.series.prevVisitors ? { previous_visitors: res.series.prevVisitors[i] ?? 0 } : {}),
  }));
  return c.json({ range: { period: range.period, from: range.from, to: range.to, timezone: site.timezone }, bucket: range.bucket, items, nextCursor: null });
});

api.get('/sites/:id/breakdown/:dim', READ, async (c) => {
  const dim = c.req.param('dim');
  if (!isDim(dim)) throw errors.not_found('There is no breakdown with that name.');
  const ctx = ctxOf(c);
  const site = await freshSite(ctx, c.req.param('id'));
  const range = rangeOf(c, site);
  const csv = c.req.query('format') === 'csv';
  const res = await breakdown(ctx.db, site, range, filtersOf(c), dim, {
    limit: limitOf(c, csv ? 1000 : 50, 1000),
    cursor: c.req.query('cursor'),
    goals: await listGoals(ctx.db, site.id),
  });
  throwIfBlocked(res.blocked);
  const items = res.items.map((row) => ({ [dim]: row.value, ...withRatios(row) })).map(({ value: _value, ...rest }) => rest);
  if (csv) return csvResponse(toCsv(items), `${site.domain}-${dim}-${range.from}-to-${range.to}.csv`);
  return c.json({ items, nextCursor: res.nextCursor, mode: res.mode, partial: res.partial });
});

api.get('/sites/:id/conversions', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await freshSite(ctx, c.req.param('id'));
  const res = await report(ctx.db, site, rangeOf(c, site), filtersOf(c), { dims: [], goals: await listGoals(ctx.db, site.id) });
  throwIfBlocked(res.blocked);
  return c.json({
    items: res.goals.map((g) => ({ goal: { id: g.goal.id, name: g.goal.name, kind: g.goal.kind, match: g.goal.match }, visitors: g.uniques, completions: g.total, conversion_rate: g.rate })),
    nextCursor: null,
  });
});

api.get('/sites/:id/events/:name/props', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  const res = await eventProps(ctx.db, site, rangeOf(c, site), c.req.param('name'));
  throwIfBlocked(res.blocked);
  return c.json({ items: res.items, nextCursor: null });
});

api.get('/sites/:id/live', READ, async (c) => {
  const ctx = ctxOf(c);
  const res = await live(ctx.db, await getSite(ctx.db, c.req.param('id')), Date.now(), true);
  return c.json({ visitors: res.visitors, first_hit_at: res.firstHitAt, pages: res.pages });
});

api.get('/sites/:id/health', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  await flushDrops(c.env);
  const res = await health(ctx.db, site);
  return c.json({ stored_today: res.storedToday, daily_cap: res.dailyCap, dropped_last_7_days: res.dropped });
});

api.get('/sites/:id/hits', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  const csv = c.req.query('format') === 'csv';
  const res = await rawHits(ctx.db, site, { limit: limitOf(c, csv ? 5000 : 100, 5000), cursor: c.req.query('cursor') });
  if (!csv) return c.json(res);
  const out = csvResponse(toCsv(res.items, { columns: HIT_COLUMNS }), `${site.domain}-hits.csv`);
  // A CSV has no room for a cursor, so it rides in a header for whoever is paging through.
  if (res.nextCursor) out.headers.set('x-next-cursor', res.nextCursor);
  return out;
});

// ---------------------------------------------------------------------------------------------
// Events API
// ---------------------------------------------------------------------------------------------

const eventSchema = z.object({
  type: z.enum(['event', 'pageview'], 'Use event or pageview.').default('event'),
  name: z.string().trim().max(120, 'Keep the name under 120 characters.').optional(),
  url: z.string().trim().min(1, 'Send the page address the event belongs to.').max(2000, 'That address is too long.'),
  referrer: z.string().max(2000).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  // Pass the visitor's own IP and user agent so the event joins the visit their browser started.
  ip: z.string().trim().max(45).optional(),
  user_agent: z.string().max(512).optional(),
});

api.post('/sites/:id/events', WRITE, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  const data = parse(eventSchema, await readJson(c));
  if (data.type === 'event' && !data.name) throw errors.validation_failed(undefined, { name: 'Give the event a name.' });
  let host = '';
  try {
    host = new URL(data.url).protocol.startsWith('http') ? new URL(data.url).hostname : '';
  } catch {
    host = '';
  }
  if (!host) throw errors.validation_failed(undefined, { url: 'Send a full address, like https://example.com/pricing.' });
  // Stands in for the visitor's browser. Without an IP every server event is one visitor called "server".
  const req = new Request('https://events.invalid/', { headers: { 'cf-connecting-ip': data.ip || 'server', 'user-agent': data.user_agent || 'server' } });
  const res = await collect(
    c.env,
    { key: site.key, kind: data.type === 'pageview' ? 'p' : 'e', name: data.name ?? null, url: data.url, referrer: data.referrer ?? null, props: data.props },
    { req, server: true },
  );
  return c.json(res.stored ? { stored: true } : { stored: false, reason: res.reason }, res.stored ? 202 : 200);
});

// ---------------------------------------------------------------------------------------------
// Goals and share links
// ---------------------------------------------------------------------------------------------

api.get('/sites/:id/goals', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  const goals = await listGoals(ctx.db, site.id);
  return c.json({ items: goals.map(({ emitted_day: _d, emitted_count: _n, org_id: _o, ...goal }) => goal), nextCursor: null });
});

api.post('/sites/:id/goals', WRITE, async (c) => {
  const { emitted_day: _d, emitted_count: _n, org_id: _o, ...goal } = await createGoal(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'goal.created', targetType: 'goal', targetId: goal.id, summary: `Added the goal ${goal.name}` });
  return c.json(goal, 201);
});

api.delete('/sites/:id/goals/:goalId', WRITE, async (c) => {
  await deleteGoal(ctxOf(c), c.req.param('id'), c.req.param('goalId'));
  await auditFromRequest(c, { action: 'goal.deleted', targetType: 'goal', targetId: c.req.param('goalId'), summary: 'Deleted a goal' });
  return c.json({ deleted: true });
});

const shareOut = (share: Parameters<typeof publicShare>[0], appUrl: string): Record<string, unknown> => {
  const { org_id: _o, ...rest } = publicShare(share);
  return { ...rest, url: `${appUrl}/a/share/${share.token}`, embed_url: `${appUrl}/a/share/${share.token}/embed` };
};

api.get('/sites/:id/shares', READ, async (c) => {
  const ctx = ctxOf(c);
  const site = await getSite(ctx.db, c.req.param('id'));
  return c.json({ items: (await listShares(ctx.db, site.id)).map((s) => shareOut(s, baseUrl(c))), nextCursor: null });
});

api.post('/sites/:id/shares', WRITE, async (c) => {
  const share = await createShare(ctxOf(c), c.req.param('id'), await readJson(c));
  await auditFromRequest(c, { action: 'share.created', targetType: 'share', targetId: share.id, summary: `Made the share link ${share.name}` });
  return c.json(shareOut(share, baseUrl(c)), 201);
});

api.delete('/sites/:id/shares/:shareId', WRITE, async (c) => {
  await deleteShare(ctxOf(c), c.req.param('id'), c.req.param('shareId'));
  await auditFromRequest(c, { action: 'share.deleted', targetType: 'share', targetId: c.req.param('shareId'), summary: 'Deleted a share link' });
  return c.json({ deleted: true });
});

export default api;
