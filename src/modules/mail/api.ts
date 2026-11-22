/** REST API, mounted at /api/v1/mail. Same actions as the dashboard, same checks. */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../env';
import { auditFromRequest } from '../../core/audit';
import { emailStatus } from '../../core/email';
import { errors, parse, readJson } from '../../core/errors';
import { requireScope } from '../../core/guards';
import { enforceRateLimit } from '../../core/ratelimit';
import { checkById, createBroadcast, deleteBroadcast, duplicateBroadcast, getBroadcast, listBroadcasts, previewBroadcast, sendTest, updateBroadcast } from './broadcasts';
import { pauseBroadcast, resumeBroadcast, scheduleBroadcast, startBroadcast, unscheduleBroadcast } from './engine';
import { checkFeed, addFeed, listFeeds, removeFeed, setFeedStatus } from './rss';
import { createField, createList, deleteField, deleteList, deleteSegment, getList, getSegment, listFields, listLists, listSegments, saveSegment, updateList } from './lists';
import { rememberBase, reqCtx } from './request';
import { audienceCount } from './broadcasts';
import { filterSchema, parseFilter } from './segments';
import { getSequence, saveSequence } from './sequences';
import { getMailSettings, saveMailSettings } from './settings';
import { broadcastStats, growth, totals } from './stats';
import {
  addTagToMany, deleteSubscriber, exportSubscribersCsv, getSubscriber, importSubscribers, joinList, querySubscribers, unsubscribe, updateSubscriber,
} from './subscribers';
import { BOUNCE_IMPORT_MAX, countSuppressions, importBounced, listSuppressions, recordBounce, recordComplaint, removeSuppression } from './suppression';
import { createTemplate, deleteTemplate, getTemplate, listTemplates, recentSent, sendTransactional, updateTemplate } from './transactional';
import { parseCsv } from '../../core/csv-parse';

const read = requireScope('mail:read');
const write = requireScope('mail:write');
const send = requireScope('mail:send');

export const api = new Hono<AppEnv>();

const csvHeaders = (name: string): Record<string, string> => ({
  'content-type': 'text/csv; charset=utf-8',
  'content-disposition': `attachment; filename="${name}"`,
  'cache-control': 'no-store',
});

const rec = (c: { req: { param: (k: string) => string } }, k = 'id') => c.req.param(k);

// Lists -------------------------------------------------------------------------------------------

api.get('/lists', read, async (c) => c.json({ items: await listLists(reqCtx(c)) }));

api.post('/lists', write, async (c) => {
  const list = await createList(reqCtx(c), await readJson(c));
  await auditFromRequest(c, { action: 'mail.list.created', targetType: 'mail_list', targetId: list.id, summary: `Created newsletter ${list.name}` });
  return c.json(list, 201);
});

api.get('/lists/:id', read, async (c) => c.json(await getList(reqCtx(c), rec(c))));

api.patch('/lists/:id', write, async (c) => {
  const list = await updateList(reqCtx(c), rec(c), await readJson(c));
  await auditFromRequest(c, { action: 'mail.list.updated', targetType: 'mail_list', targetId: list.id, summary: `Updated newsletter ${list.name}` });
  return c.json(list);
});

api.delete('/lists/:id', write, async (c) => {
  await deleteList(reqCtx(c), rec(c));
  await auditFromRequest(c, { action: 'mail.list.deleted', targetType: 'mail_list', targetId: rec(c), summary: 'Deleted a newsletter and its subscribers' });
  return c.json({ ok: true });
});

api.get('/lists/:id/sequence', read, async (c) => c.json(await getSequence(reqCtx(c), rec(c))));

api.put('/lists/:id/sequence', write, async (c) => {
  const view = await saveSequence(reqCtx(c), rec(c), await readJson(c));
  await auditFromRequest(c, { action: 'mail.sequence.saved', targetType: 'mail_list', targetId: rec(c), summary: 'Saved the welcome sequence' });
  return c.json(view);
});

api.get('/fields', read, async (c) => c.json({ items: await listFields(reqCtx(c)) }));

api.post('/fields', write, async (c) => c.json(await createField(reqCtx(c), await readJson(c)), 201));

api.delete('/fields/:id', write, async (c) => {
  await deleteField(reqCtx(c), rec(c));
  return c.json({ ok: true });
});

// Subscribers -------------------------------------------------------------------------------------

const subscriberQuery = z.object({
  list_id: z.string().optional(),
  status: z.enum(['pending', 'active', 'unsubscribed', 'suppressed']).optional(),
  tag: z.string().max(40).optional(),
  q: z.string().max(100).optional(),
  segment: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

api.get('/subscribers', read, async (c) => {
  const ctx = reqCtx(c);
  const q = parse(subscriberQuery, c.req.query());
  const segment = q.segment ? (await getSegment(ctx, q.segment)).parsed : undefined;
  return c.json(
    await querySubscribers(ctx, {
      ...(q.list_id ? { listId: q.list_id } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.tag ? { tag: q.tag } : {}),
      ...(q.q ? { q: q.q } : {}),
      ...(segment ? { segment } : {}),
      limit: q.limit ?? 50,
      offset: q.offset ?? 0,
    }),
  );
});

const addSchema = z.object({
  list_id: z.string().min(1),
  email: z.string().min(1),
  name: z.string().max(80).optional(),
  fields: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  tags: z.array(z.string()).optional(),
  /** The caller says this person agreed. Stored as the consent note. */
  confirmed: z.boolean().default(false),
});

api.post('/subscribers', write, async (c) => {
  const ctx = reqCtx(c);
  const body = parse(addSchema, await readJson(c));
  const base = await rememberBase(c);
  const list = await getList(ctx, body.list_id);
  const r = await joinList(ctx, list, { email: body.email, name: body.name, fields: body.fields, tags: body.tags, source: 'api', confirmed: body.confirmed }, { base });
  await auditFromRequest(c, { action: 'mail.subscriber.added', targetType: 'mail_subscriber', targetId: r.subscriber?.id ?? undefined, summary: `Added a subscriber (${r.outcome})` });
  return c.json({ outcome: r.outcome, subscriber: r.subscriber, created: r.created }, r.created ? 201 : 200);
});

api.post('/subscribers/import', write, async (c) => {
  const ctx = reqCtx(c);
  const body = await readJson(c);
  const input = parse(z.object({ list_id: z.string().min(1), csv: z.string().min(1).max(2_000_000), consent: z.boolean(), tags: z.array(z.string()).optional() }), body);
  await enforceRateLimit(c.env, `mail:import:${ctx.org.id}`, { limit: 20, windowSec: 3600 }, 'You have imported a lot of files this hour. Wait a bit and try again.');
  const report = await importSubscribers(ctx, { listId: input.list_id, csv: input.csv, consent: input.consent, tags: input.tags });
  await auditFromRequest(c, { action: 'mail.subscriber.imported', targetType: 'mail_list', targetId: input.list_id, summary: `Imported subscribers: ${report.added} added`, meta: { ...report } as Record<string, unknown> });
  return c.json(report, 201);
});

api.get('/subscribers/export.csv', read, async (c) => {
  const ctx = reqCtx(c);
  const q = parse(z.object({ list_id: z.string().optional(), segment: z.string().optional() }), c.req.query());
  const segment = q.segment ? (await getSegment(ctx, q.segment)).parsed : undefined;
  const csv = await exportSubscribersCsv(ctx, { ...(q.list_id ? { listId: q.list_id } : {}), ...(segment ? { segment } : {}) });
  await auditFromRequest(c, { action: 'mail.subscriber.exported', targetType: 'mail_list', targetId: q.list_id ?? undefined, summary: 'Exported subscribers' });
  return c.body(csv, 200, csvHeaders('subscribers.csv'));
});

api.post('/subscribers/tag', write, async (c) => {
  const body = parse(z.object({ ids: z.array(z.string()).min(1).max(200), tag: z.string().min(1).max(40) }), await readJson(c));
  await addTagToMany(reqCtx(c), body.ids, body.tag);
  return c.json({ ok: true });
});

api.get('/subscribers/:id', read, async (c) => c.json(await getSubscriber(reqCtx(c), rec(c))));

api.patch('/subscribers/:id', write, async (c) => c.json(await updateSubscriber(reqCtx(c), rec(c), await readJson(c))));

api.post('/subscribers/:id/unsubscribe', write, async (c) => {
  const body = parse(z.object({ list_id: z.string().min(1) }), await readJson(c));
  const changed = await unsubscribe(reqCtx(c), { s: rec(c), l: body.list_id }, 'manual');
  await auditFromRequest(c, { action: 'mail.subscriber.unsubscribed', targetType: 'mail_subscriber', targetId: rec(c), summary: 'Unsubscribed a person by hand' });
  return c.json({ ok: true, changed });
});

api.delete('/subscribers/:id', write, async (c) => {
  await deleteSubscriber(reqCtx(c), rec(c));
  await auditFromRequest(c, { action: 'mail.subscriber.deleted', targetType: 'mail_subscriber', targetId: rec(c), summary: 'Deleted a subscriber' });
  return c.json({ ok: true });
});

// Segments ----------------------------------------------------------------------------------------

api.get('/segments', read, async (c) => c.json({ items: await listSegments(reqCtx(c)) }));

api.post('/segments', write, async (c) => {
  const b = await readJson(c);
  return c.json(await saveSegment(reqCtx(c), { name: b.name, filter: b.filter }), 201);
});

api.put('/segments/:id', write, async (c) => {
  const b = await readJson(c);
  return c.json(await saveSegment(reqCtx(c), { id: rec(c), name: b.name, filter: b.filter }));
});

api.delete('/segments/:id', write, async (c) => {
  await deleteSegment(reqCtx(c), rec(c));
  return c.json({ ok: true });
});

/** How many people a filter would reach, before saving or sending. */
api.post('/segments/count', read, async (c) => {
  const body = parse(z.object({ list_id: z.string().min(1), filter: filterSchema.optional() }), await readJson(c));
  return c.json({ count: await audienceCount(reqCtx(c), body.list_id, parseFilter(JSON.stringify(body.filter ?? {}))) });
});

// Broadcasts --------------------------------------------------------------------------------------

api.get('/broadcasts', read, async (c) => {
  const q = parse(z.object({ list_id: z.string().optional(), status: z.string().max(20).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).optional() }), c.req.query());
  return c.json(await listBroadcasts(reqCtx(c), { ...(q.list_id ? { listId: q.list_id } : {}), ...(q.status ? { status: q.status } : {}), ...(q.limit ? { limit: q.limit } : {}), ...(q.offset ? { offset: q.offset } : {}) }));
});

api.post('/broadcasts', write, async (c) => {
  const b = await createBroadcast(reqCtx(c), await readJson(c));
  await auditFromRequest(c, { action: 'mail.broadcast.created', targetType: 'mail_broadcast', targetId: b.id, summary: 'Created a broadcast draft' });
  return c.json(b, 201);
});

api.get('/broadcasts/:id', read, async (c) => c.json(await getBroadcast(reqCtx(c), rec(c))));

api.patch('/broadcasts/:id', write, async (c) => c.json(await updateBroadcast(reqCtx(c), rec(c), await readJson(c))));

api.delete('/broadcasts/:id', write, async (c) => {
  await deleteBroadcast(reqCtx(c), rec(c));
  await auditFromRequest(c, { action: 'mail.broadcast.deleted', targetType: 'mail_broadcast', targetId: rec(c), summary: 'Deleted a broadcast' });
  return c.json({ ok: true });
});

api.post('/broadcasts/:id/duplicate', write, async (c) => c.json(await duplicateBroadcast(reqCtx(c), rec(c)), 201));

api.get('/broadcasts/:id/preview', read, async (c) => {
  const base = await rememberBase(c);
  const sid = c.req.query('subscriber_id');
  return c.json(await previewBroadcast(reqCtx(c), rec(c), { base, ...(sid ? { subscriberId: sid } : {}) }));
});

api.post('/broadcasts/:id/test', write, async (c) => {
  const ctx = reqCtx(c);
  await enforceRateLimit(c.env, `mail:test:${ctx.org.id}`, { limit: 20, windowSec: 3600 }, 'You sent a lot of test emails this hour. Try again later.');
  const body = parse(z.object({ to: z.string().min(1) }), await readJson(c));
  await sendTest(ctx, rec(c), body.to, await rememberBase(c));
  return c.json({ ok: true });
});

api.get('/broadcasts/:id/check', read, async (c) => c.json(await checkById(reqCtx(c), rec(c))));

api.get('/broadcasts/:id/stats', read, async (c) => {
  const ctx = reqCtx(c);
  return c.json(await broadcastStats(ctx, await getBroadcast(ctx, rec(c))));
});

api.post('/broadcasts/:id/send', send, async (c) => {
  await rememberBase(c);
  const b = await startBroadcast(reqCtx(c), rec(c));
  await auditFromRequest(c, { action: 'mail.broadcast.sent', targetType: 'mail_broadcast', targetId: b.id, summary: `Started sending "${b.subject}" to ${b.total} people` });
  return c.json(b);
});

api.post('/broadcasts/:id/schedule', send, async (c) => {
  await rememberBase(c);
  const body = parse(z.object({ at: z.union([z.number().int(), z.string()]) }), await readJson(c));
  const at = typeof body.at === 'number' ? body.at : Date.parse(body.at);
  if (!Number.isFinite(at)) throw errors.validation_failed('That time doesn’t look right.', { at: 'Use a date and time such as 2026-12-01T09:00:00Z.' });
  const b = await scheduleBroadcast(reqCtx(c), rec(c), at);
  await auditFromRequest(c, { action: 'mail.broadcast.scheduled', targetType: 'mail_broadcast', targetId: b.id, summary: `Scheduled "${b.subject}"` });
  return c.json(b);
});

api.post('/broadcasts/:id/unschedule', send, async (c) => c.json(await unscheduleBroadcast(reqCtx(c), rec(c))));
api.post('/broadcasts/:id/pause', send, async (c) => c.json(await pauseBroadcast(reqCtx(c), rec(c))));
api.post('/broadcasts/:id/resume', send, async (c) => c.json(await resumeBroadcast(reqCtx(c), rec(c))));

// Transactional templates and sending ---------------------------------------------------------------

api.get('/templates', read, async (c) => c.json({ items: await listTemplates(reqCtx(c)) }));
api.post('/templates', write, async (c) => c.json(await createTemplate(reqCtx(c), await readJson(c)), 201));
api.get('/templates/:id', read, async (c) => c.json(await getTemplate(reqCtx(c), rec(c))));
api.put('/templates/:id', write, async (c) => c.json(await updateTemplate(reqCtx(c), rec(c), await readJson(c))));
api.delete('/templates/:id', write, async (c) => {
  await deleteTemplate(reqCtx(c), rec(c));
  return c.json({ ok: true });
});

/** One email to one person, from a template or inline. Send an `Idempotency-Key` header so a retry never sends twice. */
api.post('/send', send, async (c) => {
  const key = c.req.header('idempotency-key')?.trim().slice(0, 100);
  const out = await sendTransactional(reqCtx(c), await readJson(c), { ...(key ? { idempotencyKey: key } : {}) });
  return c.json(out, out.duplicate ? 200 : 201);
});

api.get('/sent', read, async (c) => c.json({ items: await recentSent(reqCtx(c), 50) }));

// RSS to email ------------------------------------------------------------------------------------

api.get('/feeds', read, async (c) => c.json({ items: await listFeeds(reqCtx(c)) }));

api.post('/feeds', write, async (c) => {
  await rememberBase(c);
  const f = await addFeed(reqCtx(c), await readJson(c));
  await auditFromRequest(c, { action: 'mail.feed.added', targetType: 'mail_feed', targetId: f.id, summary: `Added feed ${f.url}` });
  return c.json(f, 201);
});

api.post('/feeds/:id/check', write, async (c) => {
  const ctx = reqCtx(c);
  await enforceRateLimit(c.env, `mail:feedcheck:${ctx.org.id}`, { limit: 30, windowSec: 3600 });
  const feed = (await listFeeds(ctx)).find((f) => f.id === rec(c));
  if (!feed) throw errors.not_found('We couldn’t find that feed.');
  return c.json(await checkFeed(ctx, feed));
});

api.post('/feeds/:id/pause', write, async (c) => c.json(await setFeedStatus(reqCtx(c), rec(c), 'paused')));
api.post('/feeds/:id/resume', write, async (c) => c.json(await setFeedStatus(reqCtx(c), rec(c), 'active')));
api.delete('/feeds/:id', write, async (c) => {
  await removeFeed(reqCtx(c), rec(c));
  return c.json({ ok: true });
});

// Suppression and bounces -------------------------------------------------------------------------

api.get('/suppressions', read, async (c) => {
  const ctx = reqCtx(c);
  const q = parse(z.object({ reason: z.string().max(20).optional(), q: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional() }), c.req.query());
  const [items, counts] = await Promise.all([
    listSuppressions(ctx, { ...(q.reason ? { reason: q.reason } : {}), ...(q.q ? { q: q.q } : {}), ...(q.limit ? { limit: q.limit } : {}), ...(q.offset ? { offset: q.offset } : {}) }),
    countSuppressions(ctx),
  ]);
  return c.json({ items, counts });
});

api.delete('/suppressions/:id', write, async (c) => {
  const ok = await removeSuppression(reqCtx(c), rec(c));
  if (!ok) throw errors.not_found('We couldn’t find that entry.');
  await auditFromRequest(c, { action: 'mail.suppression.removed', targetType: 'mail_suppression', targetId: rec(c), summary: 'Removed an address from the suppression list' });
  return c.json({ ok: true });
});

/** There is no provider feedback yet: a person or your own code reports a bounce or complaint here. */
api.post('/bounces', write, async (c) => {
  const body = parse(z.object({ email: z.string().min(1), type: z.enum(['bounce', 'complaint']).default('bounce'), note: z.string().max(200).default('') }), await readJson(c));
  const ctx = reqCtx(c);
  const r = body.type === 'complaint' ? await recordComplaint(ctx, body.email, body.note) : await recordBounce(ctx, body.email, body.note);
  await auditFromRequest(c, { action: `mail.suppression.${body.type}`, targetType: 'mail_subscriber', targetId: r.subscriberId ?? undefined, summary: `Marked an address as ${body.type === 'complaint' ? 'a complaint' : 'bounced'}` });
  return c.json(r, 201);
});

/** A CSV of bounced addresses, one per row or in an `email` column. Up to a few hundred at a time. */
api.post('/bounces/import', write, async (c) => {
  const body = parse(z.object({ csv: z.string().min(1).max(500_000) }), await readJson(c));
  const parsed = parseCsv(body.csv, { maxRows: BOUNCE_IMPORT_MAX + 1 });
  const hasHeader = parsed.headers.some((h) => /mail/i.test(h));
  const col = hasHeader ? Math.max(0, parsed.headers.findIndex((h) => /mail/i.test(h))) : 0;
  const addresses = [...(hasHeader ? [] : [parsed.headers[0] ?? '']), ...parsed.rows.map((r) => r[col] ?? '')].filter(Boolean);
  const r = await importBounced(reqCtx(c), addresses);
  await auditFromRequest(c, { action: 'mail.suppression.imported', targetType: 'mail_suppression', summary: `Imported ${r.added} bounced addresses` });
  return c.json(r, 201);
});

// Stats, settings, status -------------------------------------------------------------------------

api.get('/stats', read, async (c) => {
  const ctx = reqCtx(c);
  const q = parse(z.object({ list_id: z.string().optional(), days: z.coerce.number().int().min(1).max(365).optional() }), c.req.query());
  const [t, g] = await Promise.all([totals(ctx), growth(ctx, { ...(q.list_id ? { listId: q.list_id } : {}), days: q.days ?? 30 })]);
  return c.json({ totals: t, growth: g });
});

const settingsSchema = z.object({
  postalAddress: z.string().trim().max(300).optional(),
  trackOpens: z.boolean().optional(),
  trackClicks: z.boolean().optional(),
  firstRunDone: z.boolean().optional(),
});

api.get('/settings', read, async (c) => {
  const { baseUrl: _b, ...s } = await getMailSettings(c.env, reqCtx(c).org.id);
  return c.json(s);
});

api.put('/settings', write, async (c) => {
  const patch = parse(settingsSchema, await readJson(c));
  const { baseUrl: _b, ...s } = await saveMailSettings(c.env, reqCtx(c).org.id, patch);
  await auditFromRequest(c, { action: 'mail.settings.updated', targetType: 'mail_settings', summary: 'Changed Mail settings' });
  return c.json(s);
});

api.get('/status', read, async (c) => {
  const ctx = reqCtx(c);
  const [email, settings, lists] = await Promise.all([emailStatus(c.env), getMailSettings(c.env, ctx.org.id), ctx.db.count('mail_lists')]);
  return c.json({ email, postalAddressSet: settings.postalAddress.trim() !== '', lists });
});
