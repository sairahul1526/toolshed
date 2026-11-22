/** Monitors: create, change, list, delete. Works on one workspace through `orgDb`. */
import { newId, randomToken } from '../../core/db';
import { errors, parse } from '../../core/errors';
import type { ModuleContext } from '../../core/module';
import { monitorErrors } from './errors';
import { assertPublicUrl, baseUrl } from './outbound';
import {
  type MonitorInput,
  type MonitorRow,
  type ChannelRow,
  monitorSchema,
  parseHeaders,
  parseStatusSpec,
  ids,
} from './schema';
import { slotFor } from './time';

export const MAX_MONITORS = 100;

export type Ctx = Pick<ModuleContext, 'env' | 'db'> & { org?: ModuleContext['org'] };

/** The monitor as the API and the screens see it. Secrets (the ping token) are turned into a ping URL. */
export interface MonitorView {
  id: string;
  name: string;
  type: 'http' | 'heartbeat';
  url: string | null;
  method: string;
  headers: Record<string, string>;
  body: string | null;
  expectedStatus: string;
  keyword: string | null;
  keywordMode: string;
  timeoutMs: number;
  followRedirects: boolean;
  intervalMin: number;
  failAfter: number;
  slowMs: number | null;
  slowAfter: number;
  autoIncident: boolean;
  channelIds: string[] | null;
  paused: boolean;
  status: 'pending' | 'up' | 'down';
  slow: boolean;
  since: number | null;
  lastError: string | null;
  lastCode: number | null;
  incidentId: string | null;
  heartbeat: { periodSec: number; graceSec: number; pingUrl: string; lastPingAt: number | null; lastKind: string | null; lastNote: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

export function monitorView(m: MonitorRow, base: string): MonitorView {
  let headers: Record<string, string> = {};
  try {
    headers = m.headers ? (JSON.parse(m.headers) as Record<string, string>) : {};
  } catch {
    headers = {};
  }
  return {
    id: m.id,
    name: m.name,
    type: m.type,
    url: m.url,
    method: m.method,
    headers,
    body: m.body,
    expectedStatus: m.expected_status,
    keyword: m.keyword,
    keywordMode: m.keyword_mode,
    timeoutMs: m.timeout_ms,
    followRedirects: m.follow_redirects === 1,
    intervalMin: m.interval_min,
    failAfter: m.fail_after,
    slowMs: m.slow_ms,
    slowAfter: m.slow_after,
    autoIncident: m.auto_incident === 1,
    channelIds: m.channel_ids ? ids(m.channel_ids) : null,
    paused: m.paused === 1,
    status: m.status,
    slow: m.slow === 1,
    since: m.since_at,
    lastError: m.last_error,
    lastCode: m.last_code,
    incidentId: m.incident_id,
    heartbeat:
      m.type === 'heartbeat'
        ? {
            periodSec: m.hb_period_sec ?? 86_400,
            graceSec: m.hb_grace_sec,
            pingUrl: `${base}/hb/${m.hb_token}`,
            lastPingAt: m.hb_last_ping_at,
            lastKind: m.hb_last_kind,
            lastNote: m.hb_last_note,
          }
        : null,
    createdAt: m.created_at,
    updatedAt: m.updated_at,
  };
}

export function viewBase(env: { APP_URL?: string }, requestUrl?: string): string {
  return baseUrl(env, requestUrl);
}

function nameFromUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'My site';
  }
}

/** Turn validated input into table columns, checking the things a schema can't (address, status spec, headers). */
async function toColumns(ctx: Ctx, input: MonitorInput, current: MonitorRow | null): Promise<Record<string, unknown>> {
  const type = input.type ?? current?.type ?? 'http';
  if (current && input.type && input.type !== current.type) throw errors.validation_failed(undefined, { type: 'You can’t change the type of a monitor. Create a new one.' });
  const cols: Record<string, unknown> = {};
  const fail = (field: string, message: string): never => {
    throw errors.validation_failed(undefined, { [field]: message });
  };

  if (input.name !== undefined) cols.name = input.name;
  if (type === 'http') {
    const url = input.url ?? current?.url ?? undefined;
    if (!url) fail('url', 'Enter the address to check, like https://example.com.');
    if (input.url !== undefined || !current) {
      const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(url!) ? url! : `https://${url}`;
      cols.url = assertPublicUrl(normalized).toString();
    }
    if (input.method !== undefined) cols.method = input.method;
    if (input.headers !== undefined) {
      try {
        const h = parseHeaders(input.headers);
        cols.headers = Object.keys(h).length ? JSON.stringify(h) : null;
      } catch (err) {
        fail('headers', err instanceof Error ? err.message : 'Those headers aren’t valid.');
      }
    }
    if (input.body !== undefined) cols.body = input.body || null;
    if (input.expectedStatus !== undefined) {
      if (!parseStatusSpec(input.expectedStatus)) fail('expectedStatus', 'Use codes like 200, 200-299, 2xx or a list like 200,301.');
      cols.expected_status = input.expectedStatus;
    }
    if (input.keywordMode !== undefined) cols.keyword_mode = input.keywordMode;
    if (input.keyword !== undefined) cols.keyword = input.keyword || null;
    const mode = (cols.keyword_mode as string | undefined) ?? current?.keyword_mode ?? 'none';
    const kw = 'keyword' in cols ? (cols.keyword as string | null) : (current?.keyword ?? null);
    if (mode !== 'none' && !kw) fail('keyword', 'Enter the word or phrase to look for.');
    if (input.timeoutMs !== undefined) cols.timeout_ms = input.timeoutMs;
    if (input.followRedirects !== undefined) cols.follow_redirects = input.followRedirects ? 1 : 0;
    if (input.intervalMin !== undefined) cols.interval_min = input.intervalMin;
    if (input.slowMs !== undefined) cols.slow_ms = input.slowMs;
    if (input.slowAfter !== undefined) cols.slow_after = input.slowAfter;
  } else {
    if (input.hbPeriodSec !== undefined) cols.hb_period_sec = input.hbPeriodSec;
    if (input.hbGraceSec !== undefined) cols.hb_grace_sec = input.hbGraceSec;
    if (!current) {
      cols.hb_period_sec ??= 86_400;
      cols.interval_min = 1;
    }
  }
  if (input.failAfter !== undefined) cols.fail_after = input.failAfter;
  if (input.autoIncident !== undefined) cols.auto_incident = input.autoIncident ? 1 : 0;
  if (input.channelIds !== undefined) {
    if (input.channelIds === null) cols.channel_ids = null;
    else {
      const known = new Set((await ctx.db.list<ChannelRow>('mon_channels', { limit: 200 })).map((c) => c.id));
      const unknown = input.channelIds.filter((id) => !known.has(id));
      if (unknown.length) fail('channelIds', 'One of those alert channels doesn’t exist.');
      cols.channel_ids = JSON.stringify(input.channelIds);
    }
  }
  return cols;
}

export async function createMonitor(ctx: Ctx, raw: unknown, opts: { at?: number; sample?: boolean } = {}): Promise<MonitorRow> {
  const input = parse(monitorSchema, raw);
  const at = opts.at ?? Date.now();
  if ((await ctx.db.count('mon_monitors')) >= MAX_MONITORS) throw monitorErrors.limit_reached(`A workspace can have up to ${MAX_MONITORS} monitors.`);
  const type = input.type ?? 'http';
  const cols = await toColumns(ctx, input, null);
  const id = newId('mon', at);
  const name = (cols.name as string | undefined) ?? (type === 'http' ? nameFromUrl(String(cols.url)) : 'My cron job');
  const interval = (cols.interval_min as number | undefined) ?? 1;
  return ctx.db.insert<MonitorRow>('mon_monitors', {
    id,
    type,
    ...cols,
    name,
    interval_min: interval,
    slot: slotFor(id, interval),
    hb_token: type === 'heartbeat' ? randomToken(18) : null,
    sample: opts.sample ? 1 : 0,
    created_at: at,
    updated_at: at,
  });
}

export async function updateMonitor(ctx: Ctx, id: string, raw: unknown, at = Date.now()): Promise<MonitorRow> {
  const current = await getMonitor(ctx, id);
  const input = parse(monitorSchema, raw);
  const cols = await toColumns(ctx, input, current);
  if (cols.interval_min !== undefined) cols.slot = slotFor(id, cols.interval_min as number);
  const updated = await ctx.db.update<MonitorRow>('mon_monitors', id, { ...cols, updated_at: at });
  return updated ?? current;
}

export async function getMonitor(ctx: Ctx, id: string): Promise<MonitorRow> {
  const row = await ctx.db.get<MonitorRow>('mon_monitors', id);
  if (!row) throw errors.not_found('We couldn’t find that monitor.');
  return row;
}

export async function listMonitors(ctx: Ctx): Promise<MonitorRow[]> {
  return ctx.db.list<MonitorRow>('mon_monitors', { orderBy: 'created_at', limit: MAX_MONITORS + 20 });
}

export async function setPaused(ctx: Ctx, id: string, paused: boolean, at = Date.now()): Promise<MonitorRow> {
  await getMonitor(ctx, id);
  // Resuming starts fresh so an old failure streak does not trip an alert on the first check.
  const patch = paused ? { paused: 1 } : { paused: 0, fail_streak: 0, slow_streak: 0, status: 'pending', since_at: null };
  return (await ctx.db.update<MonitorRow>('mon_monitors', id, { ...patch, updated_at: at }))!;
}

/** Delete a monitor and the history that belonged to it. Status page components lose their link but stay. */
export async function deleteMonitor(ctx: Ctx, id: string): Promise<void> {
  await getMonitor(ctx, id);
  const org = ctx.db.orgId;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM mon_hourly WHERE org_id = ?1 AND monitor_id = ?2').bind(org, id),
    ctx.env.DB.prepare('DELETE FROM mon_daily WHERE org_id = ?1 AND monitor_id = ?2').bind(org, id),
    ctx.env.DB.prepare('DELETE FROM mon_state_changes WHERE org_id = ?1 AND monitor_id = ?2').bind(org, id),
    ctx.env.DB.prepare('DELETE FROM mon_failures WHERE org_id = ?1 AND monitor_id = ?2').bind(org, id),
    ctx.env.DB.prepare('UPDATE mon_components SET monitor_id = NULL WHERE org_id = ?1 AND monitor_id = ?2').bind(org, id),
    ctx.env.DB.prepare('DELETE FROM mon_monitors WHERE org_id = ?1 AND id = ?2').bind(org, id),
  ]);
}
