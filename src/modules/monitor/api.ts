/** REST API at /api/v1/monitor. Reads need monitor:read, changes need monitor:write (and the Member role for people). */
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { auditFromRequest } from '../../core/audit';
import { errors, parse, readJson } from '../../core/errors';
import { needRole, requireScope } from '../../core/guards';
import { getModuleSettings, moduleContext, setModuleSettings } from '../../core/registry';
import type { AppEnv } from '../../env';
import { channelView, createChannel, deleteChannel, getChannel, listChannels, updateChannel } from './channels';
import { testChannel } from './alerts';
import { deleteIncident, editIncident, getIncident, incidentUpdates, incidentView, listIncidents, openIncident, postUpdate } from './incidents';
import { createMaintenance, deleteMaintenance, getMaintenance, listMaintenance, updateMaintenance } from './maintenance';
import { createMonitor, deleteMonitor, getMonitor, listMonitors, monitorView, setPaused, updateMonitor, viewBase } from './monitors';
import { importCsv, monitorsCsv } from './ops';
import { assertPublicUrl } from './outbound';
import { createComponent, createGroup, createPage, deleteComponent, deleteGroup, deletePage, getPage, listPages, pageParts, reorder, updateComponent, updateGroup, updatePage } from './pages';
import { checkNow } from './runner';
import { DEFAULT_SETTINGS, moduleSettingsSchema, type MonitorSettings } from './schema';
import { listSubscribers, removeSubscriber, subscriberCounts, subscriberView } from './subscribers';
import { dailySeries, hourlySeries, recentResults, summarize } from './uptime';
import { componentView, groupView, maintenanceView, pageView } from './views';

const app = new Hono<AppEnv>();

app.use('*', async (c, next) => {
  const guard = requireScope(c.req.method === 'GET' ? 'monitor:read' : 'monitor:write');
  return guard(c, next);
});

const ctxOf = (c: Context<AppEnv>) => moduleContext(c.env, c.get('org')!);
const base = (c: Context<AppEnv>) => viewBase(c.env, c.req.url);
const rec = (c: Context<AppEnv>, action: string, targetType: string, targetId: string, summary: string) => auditFromRequest(c, { action, targetType, targetId, summary });
const query = (c: Context<AppEnv>) => Object.fromEntries(new URL(c.req.url).searchParams);

/* ------------------------------------------------------------ monitors */

app.get('/monitors', async (c) => {
  const ctx = await ctxOf(c);
  return c.json({ items: (await listMonitors(ctx)).map((m) => monitorView(m, base(c))) });
});

app.post('/monitors', async (c) => {
  const ctx = await ctxOf(c);
  const m = await createMonitor(ctx, await readJson(c));
  await rec(c, 'monitor.created', 'monitor', m.id, `Created monitor ${m.name}`);
  return c.json(monitorView(m, base(c)), 201);
});

app.get('/monitors/:id', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const changes = await ctx.db.all<{ status: string; at: number; status_code: number | null; error: string | null }>(
    'SELECT status, at, status_code, error FROM mon_state_changes WHERE org_id = :org AND monitor_id = ? ORDER BY at DESC LIMIT 20',
    m.id,
  );
  return c.json({ ...monitorView(m, base(c)), changes: changes.map((x) => ({ status: x.status, at: x.at, statusCode: x.status_code, error: x.error })) });
});

const patchMonitor = async (c: Context<AppEnv>) => {
  const ctx = await ctxOf(c);
  const m = await updateMonitor(ctx, c.req.param('id') as string, await readJson(c));
  await rec(c, 'monitor.updated', 'monitor', m.id, `Updated monitor ${m.name}`);
  return c.json(monitorView(m, base(c)));
};
app.patch('/monitors/:id', patchMonitor);
app.put('/monitors/:id', patchMonitor);

app.delete('/monitors/:id', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  await deleteMonitor(ctx, m.id);
  await rec(c, 'monitor.deleted', 'monitor', m.id, `Deleted monitor ${m.name}`);
  return c.json({ ok: true });
});

for (const [path, paused] of [['pause', true], ['resume', false]] as const) {
  app.post(`/monitors/:id/${path}`, async (c) => {
    const m = await setPaused(await ctxOf(c), c.req.param('id'), paused);
    await rec(c, paused ? 'monitor.paused' : 'monitor.resumed', 'monitor', m.id, `${paused ? 'Paused' : 'Resumed'} monitor ${m.name}`);
    return c.json(monitorView(m, base(c)));
  });
}

app.post('/monitors/:id/check', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const r = await checkNow(c.env, ctx.db.orgId, m);
  return c.json({ ok: r.ok, ms: r.ms, statusCode: r.code, error: r.error });
});

const rangeQuery = z.object({ range: z.enum(['24h', '7d', '30d', '90d']).default('24h') });

app.get('/monitors/:id/history', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const { range } = parse(rangeQuery, query(c));
  const now = Date.now();
  if (range === '24h') {
    const hours = await hourlySeries(c.env, ctx.db.orgId, m.id, 24, now);
    return c.json({ range, summary: summarize(hours.map((h) => h.b)), points: hours.map((h) => ({ at: h.hour, up: h.b?.up ?? 0, down: h.b?.down ?? 0, avgMs: h.b?.avg ?? null, p95Ms: h.b?.p95 ?? null })) });
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90;
  const series = (await dailySeries(c.env, ctx.db.orgId, [m.id], days, now)).get(m.id) ?? [];
  return c.json({ range, summary: summarize(series.map((d) => d.b)), points: series.map((d) => ({ day: d.day, up: d.b?.up ?? 0, down: d.b?.down ?? 0, avgMs: d.b?.avg ?? null, p95Ms: d.b?.p95 ?? null })) });
});

app.get('/monitors/:id/results', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const items = await recentResults(c.env, ctx.db.orgId, m.id, 60);
  return c.json({ items: items.map((r) => ({ at: r.minute, ok: r.ok, ms: r.ms, statusCode: r.code, maintenance: r.maintenance, error: r.error || null })) });
});

app.get('/monitors/:id/alerts', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMonitor(ctx, c.req.param('id'));
  const rows = await ctx.db.all<{ channel_name: string; kind: string; outcome: string; detail: string | null; at: number }>(
    'SELECT channel_name, kind, outcome, detail, at FROM mon_alerts WHERE org_id = :org AND monitor_id = ? ORDER BY at DESC LIMIT 50',
    m.id,
  );
  return c.json({ items: rows.map((r) => ({ channel: r.channel_name, kind: r.kind, outcome: r.outcome, detail: r.detail, at: r.at })) });
});

app.get('/summary', async (c) => {
  const ctx = await ctxOf(c);
  const rows = await listMonitors(ctx);
  const count = (f: (m: (typeof rows)[number]) => boolean) => rows.filter(f).length;
  return c.json({ total: rows.length, up: count((m) => !m.paused && m.status === 'up'), down: count((m) => !m.paused && m.status === 'down'), pending: count((m) => !m.paused && m.status === 'pending'), paused: count((m) => m.paused === 1) });
});

/* ------------------------------------------------------------ channels */

app.get('/channels', async (c) => c.json({ items: (await listChannels(await ctxOf(c))).map(channelView) }));

app.post('/channels', async (c) => {
  const ch = await createChannel(await ctxOf(c), await readJson(c));
  await rec(c, 'monitor.channel_created', 'channel', ch.id, `Added alert channel ${ch.name}`);
  return c.json(channelView(ch), 201);
});

const patchChannel = async (c: Context<AppEnv>) => {
  const ch = await updateChannel(await ctxOf(c), c.req.param('id') as string, await readJson(c));
  await rec(c, 'monitor.channel_updated', 'channel', ch.id, `Updated alert channel ${ch.name}`);
  return c.json(channelView(ch));
};
app.patch('/channels/:id', patchChannel);
app.put('/channels/:id', patchChannel);

app.delete('/channels/:id', async (c) => {
  const ctx = await ctxOf(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  await deleteChannel(ctx, ch.id);
  await rec(c, 'monitor.channel_deleted', 'channel', ch.id, `Deleted alert channel ${ch.name}`);
  return c.json({ ok: true });
});

app.post('/channels/:id/test', async (c) => {
  const ctx = await ctxOf(c);
  const ch = await getChannel(ctx, c.req.param('id'));
  await testChannel(c.env, ctx.db.orgId, ch, Date.now());
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ incidents */

app.get('/incidents', async (c) => {
  const q = parse(z.object({ status: z.enum(['open', 'resolved']).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), query(c));
  const rows = await listIncidents(await ctxOf(c), { open: q.status === undefined ? undefined : q.status === 'open', limit: q.limit });
  return c.json({ items: rows.map((i) => incidentView(i)) });
});

app.post('/incidents', async (c) => {
  const ctx = await ctxOf(c);
  const i = await openIncident(ctx, await readJson(c), { author: c.get('user')?.email ?? 'API' });
  await rec(c, 'monitor.incident_opened', 'incident', i.id, `Opened incident ${i.title}`);
  return c.json(incidentView(i, await incidentUpdates(ctx, i.id)), 201);
});

app.get('/incidents/:id', async (c) => {
  const ctx = await ctxOf(c);
  const i = await getIncident(ctx, c.req.param('id'));
  return c.json(incidentView(i, await incidentUpdates(ctx, i.id)));
});

app.patch('/incidents/:id', async (c) => {
  const ctx = await ctxOf(c);
  const body = await readJson(c);
  const i = await editIncident(ctx, c.req.param('id'), {
    title: typeof body.title === 'string' ? body.title : undefined,
    impact: body.impact as never,
    componentIds: Array.isArray(body.componentIds) ? (body.componentIds as string[]) : undefined,
    postmortem: body.postmortem === null ? null : typeof body.postmortem === 'string' ? body.postmortem : undefined,
  });
  await rec(c, 'monitor.incident_updated', 'incident', i.id, `Edited incident ${i.title}`);
  return c.json(incidentView(i, await incidentUpdates(ctx, i.id)));
});

app.post('/incidents/:id/updates', async (c) => {
  const ctx = await ctxOf(c);
  const i = await postUpdate(ctx, c.req.param('id'), await readJson(c), { author: c.get('user')?.email ?? 'API' });
  await rec(c, 'monitor.incident_update', 'incident', i.id, `Posted an update on ${i.title}`);
  return c.json(incidentView(i, await incidentUpdates(ctx, i.id)), 201);
});

app.delete('/incidents/:id', async (c) => {
  const ctx = await ctxOf(c);
  const i = await getIncident(ctx, c.req.param('id'));
  await deleteIncident(ctx, i.id);
  await rec(c, 'monitor.incident_deleted', 'incident', i.id, `Deleted incident ${i.title}`);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ maintenance */

app.get('/maintenance', async (c) => c.json({ items: (await listMaintenance(await ctxOf(c))).map(maintenanceView) }));

app.post('/maintenance', async (c) => {
  const m = await createMaintenance(await ctxOf(c), await readJson(c));
  await rec(c, 'monitor.maintenance_created', 'maintenance', m.id, `Scheduled maintenance ${m.title}`);
  return c.json(maintenanceView(m), 201);
});

const patchMaint = async (c: Context<AppEnv>) => {
  const m = await updateMaintenance(await ctxOf(c), c.req.param('id') as string, await readJson(c));
  await rec(c, 'monitor.maintenance_updated', 'maintenance', m.id, `Updated maintenance ${m.title}`);
  return c.json(maintenanceView(m));
};
app.patch('/maintenance/:id', patchMaint);
app.put('/maintenance/:id', patchMaint);

app.delete('/maintenance/:id', async (c) => {
  const ctx = await ctxOf(c);
  const m = await getMaintenance(ctx, c.req.param('id'));
  await deleteMaintenance(ctx, m.id);
  await rec(c, 'monitor.maintenance_deleted', 'maintenance', m.id, `Deleted maintenance ${m.title}`);
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ status pages */

app.get('/pages', async (c) => c.json({ items: (await listPages(await ctxOf(c))).map((p) => pageView(p, base(c))) }));

app.post('/pages', async (c) => {
  const p = await createPage(await ctxOf(c), await readJson(c));
  await rec(c, 'monitor.page_created', 'page', p.id, `Created status page ${p.title}`);
  return c.json(pageView(p, base(c)), 201);
});

app.get('/pages/:id', async (c) => {
  const ctx = await ctxOf(c);
  const p = await getPage(ctx, c.req.param('id'));
  const parts = await pageParts(ctx, p.id);
  return c.json({ ...pageView(p, base(c)), groups: parts.groups.map(groupView), components: parts.components.map(componentView) });
});

const patchPage = async (c: Context<AppEnv>) => {
  const p = await updatePage(await ctxOf(c), c.req.param('id') as string, await readJson(c));
  await rec(c, 'monitor.page_updated', 'page', p.id, `Updated status page ${p.title}`);
  return c.json(pageView(p, base(c)));
};
app.patch('/pages/:id', patchPage);
app.put('/pages/:id', patchPage);

app.delete('/pages/:id', async (c) => {
  const ctx = await ctxOf(c);
  const p = await getPage(ctx, c.req.param('id'));
  await deletePage(ctx, p.id);
  await rec(c, 'monitor.page_deleted', 'page', p.id, `Deleted status page ${p.title}`);
  return c.json({ ok: true });
});

app.post('/pages/:id/groups', async (c) => c.json(groupView(await createGroup(await ctxOf(c), c.req.param('id'), await readJson(c))), 201));
app.patch('/groups/:id', async (c) => c.json(groupView(await updateGroup(await ctxOf(c), c.req.param('id'), await readJson(c)))));
app.delete('/groups/:id', async (c) => {
  await deleteGroup(await ctxOf(c), c.req.param('id'));
  return c.json({ ok: true });
});

app.post('/pages/:id/components', async (c) => c.json(componentView(await createComponent(await ctxOf(c), c.req.param('id'), await readJson(c))), 201));
app.patch('/components/:id', async (c) => c.json(componentView(await updateComponent(await ctxOf(c), c.req.param('id'), await readJson(c)))));
app.delete('/components/:id', async (c) => {
  await deleteComponent(await ctxOf(c), c.req.param('id'));
  return c.json({ ok: true });
});

app.put('/pages/:id/order', async (c) => {
  const body = await readJson(c);
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
  await reorder(await ctxOf(c), c.req.param('id'), { groups: list(body.groups), components: list(body.components) });
  return c.json({ ok: true });
});

app.get('/pages/:id/subscribers', async (c) => {
  const ctx = await ctxOf(c);
  const p = await getPage(ctx, c.req.param('id'));
  const [rows, counts] = await Promise.all([listSubscribers(ctx, p.id), subscriberCounts(ctx, p.id)]);
  return c.json({ ...counts, items: rows.map(subscriberView) });
});

app.delete('/subscribers/:id', async (c) => {
  await removeSubscriber(await ctxOf(c), c.req.param('id'));
  return c.json({ ok: true });
});

/* ------------------------------------------------------------ settings, import, export */

app.get('/settings', async (c) => c.json(await getModuleSettings<MonitorSettings>(c.env, c.get('org')!.id, 'monitor', DEFAULT_SETTINGS)));

app.put('/settings', async (c) => {
  needRole(c, 'admin');
  const input = parse(moduleSettingsSchema, await readJson(c));
  const cur = await getModuleSettings<MonitorSettings>(c.env, c.get('org')!.id, 'monitor', DEFAULT_SETTINGS);
  const next = { ...cur, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) };
  if (next.aliveUrl) {
    assertPublicUrl(String(next.aliveUrl), 'aliveUrl');
  }
  await setModuleSettings(c.env, c.get('org')!.id, 'monitor', next);
  await rec(c, 'monitor.settings_updated', 'settings', 'monitor', 'Changed Monitor settings');
  return c.json(next);
});

app.post('/import', async (c) => {
  const type = c.req.header('content-type') ?? '';
  let text = '';
  if (type.includes('application/json')) {
    const body = await readJson(c);
    text = typeof body.csv === 'string' ? body.csv : '';
  } else {
    text = await c.req.text();
  }
  if (text.length > 500_000) throw errors.too_large('Keep the file under 500 KB.');
  const report = await importCsv(await ctxOf(c), text);
  await rec(c, 'monitor.imported', 'monitor', 'import', `Imported ${report.created} monitors`);
  return c.json(report, report.created ? 201 : 200);
});

app.get('/export/monitors.csv', async (c) => {
  const csv = await monitorsCsv(await ctxOf(c));
  return new Response(csv, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="monitors.csv"' } });
});

export default app;
