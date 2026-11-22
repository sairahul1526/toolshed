/** Everything around the edges: CSV import and export, sample data, the "alive" ping, and the numbers for the Overview. */
import { toCsv } from '../../core/csv';
import { parseCsv } from '../../core/csv-parse';
import { getModuleSettings } from '../../core/registry';
import type { ModuleContext } from '../../core/module';
import type { Env } from '../../env';
import { openIncident, postUpdate } from './incidents';
import { createMaintenance } from './maintenance';
import { MAX_MONITORS, createMonitor, deleteMonitor, listMonitors, type Ctx } from './monitors';
import { monitorErrors } from './errors';
import { createComponent, createGroup, createPage, deletePage } from './pages';
import { safeFetch } from './outbound';
import { DEFAULT_SETTINGS, INTERVALS, type MonitorSettings } from './schema';
import { DAY, dayKey, MINUTE } from './time';

/* ------------------------------------------------------------------ CSV */

export interface ImportReport {
  created: number;
  skipped: { row: number; name: string; reason: string }[];
  /** Rows left for a second import because one request does only so many. */
  remaining: number;
}

/** How many monitors one import makes. Each costs a couple of database calls and a request may make 50. */
export const IMPORT_MAX = 20;

const find = (header: string[], ...words: RegExp[]): number => header.findIndex((h) => words.some((w) => w.test(h.trim().toLowerCase())));

/**
 * Import monitors from a CSV. Reads the header row and guesses the columns (UptimeRobot's export,
 * or any file with a name and an address): name, url/host, type, keyword, interval.
 */
export async function importCsv(ctx: Ctx, text: string, at = Date.now()): Promise<ImportReport> {
  const parsed = parseCsv(text, { maxRows: 5000 });
  if (parsed.rows.length === 0) throw monitorErrors.import_empty();
  const header = parsed.headers;
  const iUrl = find(header, /^url/, /url|link|host|address|ip/);
  const iName = find(header, /friendly|^name|monitor name|^monitor$/, /name/);
  const iType = find(header, /^type$/, /type/);
  const iKeyword = find(header, /keyword/);
  const iInterval = find(header, /interval/);
  if (iUrl < 0) throw monitorErrors.import_empty('We couldn’t find a column with the website address. Add a header row with a “URL” column.');
  const body = parsed.rows;
  const room = Math.max(0, MAX_MONITORS - (await ctx.db.count('mon_monitors')));
  const batch = body.slice(0, Math.min(IMPORT_MAX, room));
  const report: ImportReport = { created: 0, skipped: [], remaining: body.length - batch.length };
  let n = 0;
  for (const r of batch) {
    n++;
    const url = (r[iUrl] ?? '').trim();
    const name = ((iName >= 0 ? r[iName] : '') ?? '').trim();
    const type = ((iType >= 0 ? r[iType] : '') ?? '').trim().toLowerCase();
    const keyword = ((iKeyword >= 0 ? r[iKeyword] : '') ?? '').trim();
    const rawInterval = Number((iInterval >= 0 ? r[iInterval] : '') ?? '');
    if (!url) {
      report.skipped.push({ row: n + 1, name, reason: 'No address.' });
      continue;
    }
    if (type && !/http|keyword|web|^$/.test(type)) {
      report.skipped.push({ row: n + 1, name: name || url, reason: `“${type}” checks aren’t supported. Only websites and keywords.` });
      continue;
    }
    // UptimeRobot writes seconds (300); other tools write minutes (5).
    const minutes = rawInterval >= 60 ? rawInterval / 60 : rawInterval;
    const intervalMin = INTERVALS.reduce((best, v) => (Math.abs(v - minutes) < Math.abs(best - minutes) ? v : best), INTERVALS[0]!);
    try {
      await createMonitor(
        ctx,
        { type: 'http', name: name || undefined, url, ...(keyword ? { keyword, keywordMode: 'present' } : {}), ...(minutes > 0 ? { intervalMin } : {}) },
        { at: at + n },
      );
      report.created++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not import it.';
      report.skipped.push({ row: n + 1, name: name || url, reason: msg });
    }
  }
  return report;
}

export async function monitorsCsv(ctx: Ctx): Promise<string> {
  const rows = await listMonitors(ctx);
  return toCsv(
    rows.map((m) => ({
      name: m.name,
      type: m.type,
      url: m.url,
      method: m.method,
      expected_status: m.expected_status,
      keyword: m.keyword,
      keyword_mode: m.keyword_mode,
      interval_minutes: m.interval_min,
      timeout_ms: m.timeout_ms,
      status: m.paused ? 'paused' : m.status,
    })),
    { columns: ['name', 'type', 'url', 'method', 'expected_status', 'keyword', 'keyword_mode', 'interval_minutes', 'timeout_ms', 'status'] },
  );
}

/** Everything the module stores, for the workspace Export. Secrets in channel settings are left out. */
export async function exportData(ctx: ModuleContext): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  const tables = ['mon_monitors', 'mon_channels', 'mon_incidents', 'mon_incident_updates', 'mon_maintenance', 'mon_pages', 'mon_groups', 'mon_components', 'mon_subscribers', 'mon_daily', 'mon_state_changes'];
  for (const t of tables) {
    const rows = await ctx.db.all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE org_id = :org LIMIT 20000`);
    out[t] = t === 'mon_channels' ? rows.map((r) => ({ ...r, config: '(hidden)' })) : t === 'mon_monitors' ? rows.map((r) => ({ ...r, hb_token: r.hb_token ? '(hidden)' : null })) : t === 'mon_subscribers' ? rows.map((r) => ({ ...r, token: '(hidden)' })) : rows;
  }
  return out;
}

/* ------------------------------------------------------------------ sample data */

/** Believable history for sample monitors: `days` daily rows, with one bad day. One statement. */
async function writeSampleHistory(env: Env, orgId: string, monitorId: string, base: number, at: number, bad: number[]): Promise<void> {
  const rows: unknown[][] = [];
  for (let i = 0; i < 90; i++) {
    const day = dayKey(at - i * DAY);
    const total = 1440;
    const down = bad.includes(i) ? 38 + ((i * 7) % 30) : i % 23 === 0 ? 2 : 0;
    rows.push([monitorId, day, total - down, down, base + ((i * 13) % 60), base + 140 + ((i * 29) % 120)]);
  }
  await env.DB.prepare(
    `INSERT INTO mon_daily (org_id, monitor_id, day, up, down, avg_ms, p95_ms)
     SELECT ?1, json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'), json_extract(value, '$[5]') FROM json_each(?2) WHERE true
     ON CONFLICT (monitor_id, day) DO NOTHING`,
  )
    .bind(orgId, JSON.stringify(rows))
    .run();
}

export async function sampleData(ctx: ModuleContext): Promise<void> {
  const at = Date.now();
  const mk = async (name: string, url: string, base: number, bad: number[], extra: Record<string, unknown> = {}) => {
    const m = await createMonitor(ctx, { name, url, ...extra }, { at: at - DAY * 90, sample: true });
    await ctx.db.update('mon_monitors', m.id, { status: 'up', since_at: at - 40 * DAY });
    await writeSampleHistory(ctx.env, ctx.org.id, m.id, base, at, bad);
    return m;
  };
  const web = await mk('Marketing website', 'https://example.com', 180, [41]);
  const api = await mk('API', 'https://api.example.com/health', 90, [12, 13]);
  const app = await mk('Web app', 'https://app.example.com', 240, []);
  const page = await createPage(ctx, { title: 'Acme status', slug: undefined, description: 'Live status for Acme’s website, API and app.' }, { at, sample: true });
  const grp = await createGroup(ctx, page.id, { name: 'Product' });
  await createComponent(ctx, page.id, { name: 'Website', monitorId: web.id });
  await createComponent(ctx, page.id, { name: 'API', monitorId: api.id, groupId: grp.id });
  await createComponent(ctx, page.id, { name: 'Web app', monitorId: app.id, groupId: grp.id });
  const inc = await openIncident(ctx, { title: 'Elevated API errors', impact: 'minor', body: 'We’re seeing more errors than usual from the API and are looking into it.' }, { at: at - 12 * DAY, sample: true, silent: true, author: 'Sample' });
  await postUpdate(ctx, inc.id, { status: 'resolved', body: 'A bad deploy was rolled back. Everything is normal again.' }, { at: at - 12 * DAY + 52 * MINUTE, silent: true, author: 'Sample' });
  await createMaintenance(ctx, { title: 'Database upgrade', body: 'Short read-only period while we upgrade the database.', startsAt: at + 3 * DAY, durationMin: 30, notify: false }, { at, sample: true });
}

export async function clearSampleData(ctx: ModuleContext): Promise<void> {
  const sampleMonitors = await ctx.db.all<{ id: string }>('SELECT id FROM mon_monitors WHERE org_id = :org AND sample = 1');
  for (const m of sampleMonitors) await deleteMonitor(ctx, m.id);
  const pages = await ctx.db.all<{ id: string }>('SELECT id FROM mon_pages WHERE org_id = :org AND sample = 1');
  for (const p of pages) await deletePage(ctx, p.id);
  const o = ctx.db.orgId;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM mon_incident_updates WHERE org_id = ?1 AND incident_id IN (SELECT id FROM mon_incidents WHERE org_id = ?1 AND sample = 1)').bind(o),
    ctx.env.DB.prepare('DELETE FROM mon_incidents WHERE org_id = ?1 AND sample = 1').bind(o),
    ctx.env.DB.prepare('DELETE FROM mon_maintenance WHERE org_id = ?1 AND sample = 1').bind(o),
    ctx.env.DB.prepare('DELETE FROM mon_subscribers WHERE org_id = ?1 AND sample = 1').bind(o),
  ]);
}

/* ------------------------------------------------------------------ alive ping, counts */

/**
 * "Alive" ping out: once every N minutes, GET the address a person chose (their own heartbeat monitor
 * elsewhere, or a Healthchecks.io check), so they find out when this install itself stops running.
 */
export async function aliveSchedule(env: Env, at: Date): Promise<void> {
  const orgs = (await env.DB.prepare(`SELECT DISTINCT org_id FROM mon_monitors LIMIT 50`).all<{ org_id: string }>()).results;
  const minute = Math.floor(at.getTime() / MINUTE);
  for (const { org_id } of orgs) {
    const s = await getModuleSettings<MonitorSettings>(env, org_id, 'monitor', DEFAULT_SETTINGS);
    if (!s.aliveUrl || minute % Math.max(1, s.aliveEveryMin) !== 0) continue;
    try {
      await safeFetch(s.aliveUrl, { method: 'GET', headers: {}, timeoutMs: 5000, followRedirects: true }, false);
    } catch (err) {
      console.error('[monitor] alive ping failed', err instanceof Error ? err.message : err);
    }
  }
}

export async function monitorCount(ctx: ModuleContext): Promise<number> {
  return ctx.db.count('mon_monitors');
}

export async function overview(ctx: ModuleContext) {
  const rows = await ctx.db.all<{ status: string; paused: number; n: number }>('SELECT status, paused, COUNT(*) AS n FROM mon_monitors WHERE org_id = :org GROUP BY status, paused');
  const total = rows.reduce((s, r) => s + r.n, 0);
  const down = rows.filter((r) => r.status === 'down' && !r.paused).reduce((s, r) => s + r.n, 0);
  const openInc = (await ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mon_incidents WHERE org_id = :org AND status != 'resolved'`))?.n ?? 0;
  return [
    { label: 'Monitors down', value: total ? `${down} of ${total}` : '0', href: '/app/monitor' },
    { label: 'Open incidents', value: String(openInc), href: '/app/monitor/incidents' },
  ];
}
