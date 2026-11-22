/** Incidents: a timeline of updates people can read on the status page. Opened by a monitor or by hand. */
import { newId } from '../../core/db';
import { emit } from '../../core/events';
import { enqueue } from '../../core/jobs';
import { errors, parse } from '../../core/errors';
import type { Env } from '../../env';
import { fmtDuration } from './fmt';
import type { Ctx } from './monitors';
import { type Impact, type IncidentRow, type IncidentStatus, type IncidentUpdateRow, type MonitorRow, ids, incidentSchema, incidentUpdateSchema } from './schema';

export interface IncidentView {
  id: string;
  title: string;
  status: IncidentStatus;
  impact: Impact;
  monitorId: string | null;
  auto: boolean;
  componentIds: string[];
  postmortem: string | null;
  startedAt: number;
  resolvedAt: number | null;
  updates?: { id: string; status: IncidentStatus; body: string; at: number; author: string | null }[];
}

export function incidentView(i: IncidentRow, updates?: IncidentUpdateRow[]): IncidentView {
  return {
    id: i.id,
    title: i.title,
    status: i.status,
    impact: i.impact,
    monitorId: i.monitor_id,
    auto: i.auto === 1,
    componentIds: ids(i.component_ids),
    postmortem: i.postmortem,
    startedAt: i.started_at,
    resolvedAt: i.resolved_at,
    ...(updates ? { updates: updates.map((u) => ({ id: u.id, status: u.status, body: u.body, at: u.at, author: u.author })) } : {}),
  };
}

export async function getIncident(ctx: Ctx, id: string): Promise<IncidentRow> {
  const row = await ctx.db.get<IncidentRow>('mon_incidents', id);
  if (!row) throw errors.not_found('We couldn’t find that incident.');
  return row;
}

export async function incidentUpdates(ctx: Ctx, incidentId: string): Promise<IncidentUpdateRow[]> {
  return ctx.db.all<IncidentUpdateRow>('SELECT * FROM mon_incident_updates WHERE org_id = :org AND incident_id = ? ORDER BY at ASC, id ASC', incidentId);
}

export async function listIncidents(ctx: Ctx, opts: { open?: boolean; limit?: number; before?: number } = {}): Promise<IncidentRow[]> {
  const where: string[] = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.open === true) where.push(`status != 'resolved'`);
  if (opts.open === false) where.push(`status = 'resolved'`);
  if (opts.before) {
    where.push('started_at < ?');
    params.push(opts.before);
  }
  return ctx.db.all<IncidentRow>(`SELECT * FROM mon_incidents WHERE ${where.join(' AND ')} ORDER BY started_at DESC LIMIT ${Math.min(opts.limit ?? 50, 200)}`, ...params);
}

async function announce(env: Env, orgId: string, name: 'incident.opened' | 'incident.updated' | 'incident.resolved', i: IncidentRow, updateId: string, at: number): Promise<void> {
  await emit(env, { orgId, module: 'monitor', name, subject: i.id, data: { title: i.title, status: i.status, impact: i.impact }, at });
  await enqueue(env, 'monitor.notify', { orgId, kind: 'incident', incidentId: i.id, updateId });
}

/** Open an incident with its first update. */
export async function openIncident(
  ctx: Ctx,
  raw: unknown,
  opts: { at?: number; auto?: boolean; sample?: boolean; author?: string | null; componentIds?: string[]; monitorId?: string; silent?: boolean } = {},
): Promise<IncidentRow> {
  const input = parse(incidentSchema, raw);
  const at = opts.at ?? Date.now();
  const status = input.status ?? 'investigating';
  const id = newId('inc', at);
  const incident = await ctx.db.insert<IncidentRow>('mon_incidents', {
    id,
    title: input.title,
    status,
    impact: input.impact ?? 'minor',
    monitor_id: opts.monitorId ?? input.monitorId ?? null,
    auto: opts.auto ? 1 : 0,
    component_ids: JSON.stringify(opts.componentIds ?? input.componentIds ?? []),
    started_at: at,
    resolved_at: status === 'resolved' ? at : null,
    sample: opts.sample ? 1 : 0,
    created_at: at,
    updated_at: at,
  });
  const updateId = newId('upd', at);
  await ctx.db.insert('mon_incident_updates', { id: updateId, incident_id: id, status, body: input.body || 'We are looking into it.', at, author: opts.author ?? null });
  if (!opts.silent) await announce(ctx.env, ctx.db.orgId, 'incident.opened', incident, updateId, at);
  return incident;
}

/** Add a timeline update and move the incident to its status. Resolved incidents can be reopened this way. */
export async function postUpdate(ctx: Ctx, id: string, raw: unknown, opts: { at?: number; author?: string | null; silent?: boolean } = {}): Promise<IncidentRow> {
  const input = parse(incidentUpdateSchema, raw);
  const at = opts.at ?? Date.now();
  const cur = await getIncident(ctx, id);
  const updateId = newId('upd', at);
  await ctx.db.insert('mon_incident_updates', { id: updateId, incident_id: id, status: input.status, body: input.body, at, author: opts.author ?? null });
  const next = (await ctx.db.update<IncidentRow>('mon_incidents', id, {
    status: input.status,
    resolved_at: input.status === 'resolved' ? at : null,
    updated_at: at,
  }))!;
  if (!opts.silent) await announce(ctx.env, ctx.db.orgId, input.status === 'resolved' && cur.status !== 'resolved' ? 'incident.resolved' : 'incident.updated', next, updateId, at);
  return next;
}

export async function editIncident(ctx: Ctx, id: string, raw: { title?: string; impact?: Impact; componentIds?: string[]; postmortem?: string | null }, at = Date.now()): Promise<IncidentRow> {
  await getIncident(ctx, id);
  const patch: Record<string, unknown> = { updated_at: at };
  if (raw.title !== undefined) {
    const t = raw.title.trim();
    if (!t || t.length > 150) throw errors.validation_failed(undefined, { title: 'Give the incident a title of up to 150 characters.' });
    patch.title = t;
  }
  if (raw.impact !== undefined) {
    if (!['minor', 'major', 'critical'].includes(raw.impact)) throw errors.validation_failed(undefined, { impact: 'Choose minor, major or critical.' });
    patch.impact = raw.impact;
  }
  if (raw.componentIds !== undefined) patch.component_ids = JSON.stringify(raw.componentIds.slice(0, 100));
  if (raw.postmortem !== undefined) {
    if (raw.postmortem && raw.postmortem.length > 20_000) throw errors.validation_failed(undefined, { postmortem: 'Keep the postmortem under 20,000 characters.' });
    patch.postmortem = raw.postmortem ? raw.postmortem : null;
  }
  return (await ctx.db.update<IncidentRow>('mon_incidents', id, patch))!;
}

export async function deleteIncident(ctx: Ctx, id: string): Promise<void> {
  await getIncident(ctx, id);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM mon_incident_updates WHERE org_id = ?1 AND incident_id = ?2').bind(ctx.db.orgId, id),
    ctx.env.DB.prepare('DELETE FROM mon_incidents WHERE org_id = ?1 AND id = ?2').bind(ctx.db.orgId, id),
  ]);
}

/** A monitor went down: open its incident unless it already has one open. */
export async function openForMonitor(ctx: Ctx, m: MonitorRow, error: string | null, at: number): Promise<IncidentRow | null> {
  if (m.auto_incident !== 1) return null;
  if (m.incident_id) {
    const existing = await ctx.db.get<IncidentRow>('mon_incidents', m.incident_id);
    if (existing && existing.status !== 'resolved') return existing;
  }
  const comps = await ctx.db.all<{ id: string }>('SELECT id FROM mon_components WHERE org_id = :org AND monitor_id = ?', m.id);
  const incident = await openIncident(
    ctx,
    { title: `${m.name} is down`, impact: 'major', body: `Our checks are failing${error ? `: ${error}` : ''}. We are looking into it.` },
    { at, auto: true, monitorId: m.id, componentIds: comps.map((c) => c.id), author: 'Monitor' },
  );
  await ctx.db.update('mon_monitors', m.id, { incident_id: incident.id });
  return incident;
}

/** A monitor is back: resolve the incident it opened. */
export async function resolveForMonitor(ctx: Ctx, m: MonitorRow, at: number): Promise<void> {
  if (!m.incident_id) return;
  const inc = await ctx.db.get<IncidentRow>('mon_incidents', m.incident_id);
  if (inc && inc.status !== 'resolved') {
    await postUpdate(ctx, inc.id, { status: 'resolved', body: `Our checks are passing again. It was down for ${fmtDuration(at - inc.started_at)}.` }, { at, author: 'Monitor' });
  }
  await ctx.db.update('mon_monitors', m.id, { incident_id: null });
}
