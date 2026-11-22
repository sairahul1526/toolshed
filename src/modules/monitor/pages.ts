/** Status pages: the pages, their groups and components, and the public view of them. */
import { newId, randomToken } from '../../core/db';
import { errors, parse } from '../../core/errors';
import type { Env } from '../../env';
import { monitorErrors } from './errors';
import { RELEVANT_SQL, currentOrNext, isCovered, workspaceZone, type Occurrence } from './maintenance';
import type { Ctx } from './monitors';
import {
  type ComponentRow,
  type GroupRow,
  type IncidentRow,
  type IncidentUpdateRow,
  type MaintenanceRow,
  type MonitorRow,
  type PageRow,
  componentSchema,
  groupSchema,
  ids,
  pageSchema,
} from './schema';
import { DAY } from './time';
import { dailySeries, summarize } from './uptime';

export const MAX_PAGES = 10;
export const MAX_COMPONENTS = 100;

const RESERVED_SLUGS = new Set(['api', 'app', 'assets', 'new', 'status', 'admin', 'www']);

function slugify(title: string): string {
  const base = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  return base.length >= 3 ? base : `status-${base}`.replace(/-$/, '');
}

async function slugFree(env: Env, slug: string, exceptId?: string): Promise<boolean> {
  if (RESERVED_SLUGS.has(slug)) return false;
  const row = await env.DB.prepare('SELECT id FROM mon_pages WHERE slug = ?1').bind(slug).first<{ id: string }>();
  return !row || row.id === exceptId;
}

export async function listPages(ctx: Ctx): Promise<PageRow[]> {
  return ctx.db.all<PageRow>('SELECT * FROM mon_pages WHERE org_id = :org ORDER BY created_at ASC');
}

export async function getPage(ctx: Ctx, id: string): Promise<PageRow> {
  const row = await ctx.db.get<PageRow>('mon_pages', id);
  if (!row) throw errors.not_found('We couldn’t find that status page.');
  return row;
}

export async function createPage(ctx: Ctx, raw: unknown, opts: { at?: number; sample?: boolean } = {}): Promise<PageRow> {
  const input = parse(pageSchema, raw);
  const at = opts.at ?? Date.now();
  if ((await ctx.db.count('mon_pages')) >= MAX_PAGES) throw monitorErrors.limit_reached(`A workspace can have up to ${MAX_PAGES} status pages.`);
  let slug = input.slug;
  if (slug) {
    if (!(await slugFree(ctx.env, slug))) throw monitorErrors.slug_taken(undefined, { slug: 'That address is taken. Pick another one.' });
  } else {
    slug = slugify(input.title);
    if (!(await slugFree(ctx.env, slug))) slug = `${slug.slice(0, 30)}-${randomToken(3)}`.toLowerCase().replace(/[^a-z0-9-]/g, '');
  }
  return ctx.db.insert<PageRow>('mon_pages', {
    id: newId('pag', at),
    slug,
    title: input.title,
    description: input.description ?? null,
    website_url: input.websiteUrl ?? null,
    custom_css: input.customCss ?? null,
    published: input.published === false ? 0 : 1,
    hide_from_search: input.hideFromSearch ? 1 : 0,
    allow_subscribe: input.allowSubscribe === false ? 0 : 1,
    uptime_days: input.uptimeDays ?? 90,
    sample: opts.sample ? 1 : 0,
    created_at: at,
    updated_at: at,
  });
}

export async function updatePage(ctx: Ctx, id: string, raw: unknown, at = Date.now()): Promise<PageRow> {
  const cur = await getPage(ctx, id);
  const input = parse(pageSchema.partial({ title: true }), raw);
  const patch: Record<string, unknown> = { updated_at: at };
  if (input.title !== undefined) patch.title = input.title;
  if (input.slug !== undefined && input.slug !== cur.slug) {
    if (!(await slugFree(ctx.env, input.slug, id))) throw monitorErrors.slug_taken(undefined, { slug: 'That address is taken. Pick another one.' });
    patch.slug = input.slug;
  }
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.websiteUrl !== undefined) patch.website_url = input.websiteUrl ?? null;
  if (input.customCss !== undefined) patch.custom_css = input.customCss ?? null;
  if (input.published !== undefined) patch.published = input.published ? 1 : 0;
  if (input.hideFromSearch !== undefined) patch.hide_from_search = input.hideFromSearch ? 1 : 0;
  if (input.allowSubscribe !== undefined) patch.allow_subscribe = input.allowSubscribe ? 1 : 0;
  if (input.uptimeDays !== undefined) patch.uptime_days = input.uptimeDays;
  return (await ctx.db.update<PageRow>('mon_pages', id, patch))!;
}

export async function deletePage(ctx: Ctx, id: string): Promise<void> {
  await getPage(ctx, id);
  const o = ctx.db.orgId;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM mon_subscribers WHERE org_id = ?1 AND page_id = ?2').bind(o, id),
    ctx.env.DB.prepare('DELETE FROM mon_components WHERE org_id = ?1 AND page_id = ?2').bind(o, id),
    ctx.env.DB.prepare('DELETE FROM mon_groups WHERE org_id = ?1 AND page_id = ?2').bind(o, id),
    ctx.env.DB.prepare('DELETE FROM mon_pages WHERE org_id = ?1 AND id = ?2').bind(o, id),
  ]);
}

export async function pageParts(ctx: Ctx, pageId: string): Promise<{ groups: GroupRow[]; components: ComponentRow[] }> {
  const groups = await ctx.db.all<GroupRow>('SELECT * FROM mon_groups WHERE org_id = :org AND page_id = ? ORDER BY position, id', pageId);
  const components = await ctx.db.all<ComponentRow>('SELECT * FROM mon_components WHERE org_id = :org AND page_id = ? ORDER BY position, id', pageId);
  return { groups, components };
}

export async function createGroup(ctx: Ctx, pageId: string, raw: unknown): Promise<GroupRow> {
  await getPage(ctx, pageId);
  const input = parse(groupSchema, raw);
  const position = await ctx.db.count('mon_groups', { page_id: pageId });
  return ctx.db.insert<GroupRow>('mon_groups', { id: newId('grp'), page_id: pageId, name: input.name, position, collapsed: input.collapsed ? 1 : 0 });
}

export async function updateGroup(ctx: Ctx, id: string, raw: unknown): Promise<GroupRow> {
  if (!(await ctx.db.get('mon_groups', id))) throw errors.not_found('We couldn’t find that group.');
  const input = parse(groupSchema.partial(), raw);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.collapsed !== undefined) patch.collapsed = input.collapsed ? 1 : 0;
  return (await ctx.db.update<GroupRow>('mon_groups', id, patch))!;
}

export async function deleteGroup(ctx: Ctx, id: string): Promise<void> {
  if (!(await ctx.db.get('mon_groups', id))) throw errors.not_found('We couldn’t find that group.');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE mon_components SET group_id = NULL WHERE org_id = ?1 AND group_id = ?2').bind(ctx.db.orgId, id),
    ctx.env.DB.prepare('DELETE FROM mon_groups WHERE org_id = ?1 AND id = ?2').bind(ctx.db.orgId, id),
  ]);
}

async function checkLinks(ctx: Ctx, pageId: string, input: { monitorId?: string; groupId?: string }): Promise<void> {
  if (input.monitorId && !(await ctx.db.get('mon_monitors', input.monitorId))) throw errors.validation_failed(undefined, { monitorId: 'Choose one of your monitors.' });
  if (input.groupId) {
    const g = await ctx.db.get<GroupRow>('mon_groups', input.groupId);
    if (!g || g.page_id !== pageId) throw errors.validation_failed(undefined, { groupId: 'Choose a group on this page.' });
  }
}

export async function createComponent(ctx: Ctx, pageId: string, raw: unknown): Promise<ComponentRow> {
  await getPage(ctx, pageId);
  const input = parse(componentSchema, raw);
  if ((await ctx.db.count('mon_components', { page_id: pageId })) >= MAX_COMPONENTS) throw monitorErrors.limit_reached(`A page can have up to ${MAX_COMPONENTS} components.`);
  await checkLinks(ctx, pageId, input);
  const position = await ctx.db.count('mon_components', { page_id: pageId });
  return ctx.db.insert<ComponentRow>('mon_components', {
    id: newId('cmp'),
    page_id: pageId,
    group_id: input.groupId ?? null,
    name: input.name,
    description: input.description ?? null,
    monitor_id: input.monitorId ?? null,
    manual_status: input.monitorId ? null : (input.manualStatus ?? 'operational'),
    position,
    show_uptime: input.showUptime === false ? 0 : 1,
  });
}

export async function updateComponent(ctx: Ctx, id: string, raw: unknown): Promise<ComponentRow> {
  const cur = await ctx.db.get<ComponentRow>('mon_components', id);
  if (!cur) throw errors.not_found('We couldn’t find that component.');
  const input = parse(componentSchema.partial(), raw);
  await checkLinks(ctx, cur.page_id, input);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description ?? null;
  if (input.monitorId !== undefined) patch.monitor_id = input.monitorId ?? null;
  if (input.groupId !== undefined) patch.group_id = input.groupId ?? null;
  if (input.manualStatus !== undefined) patch.manual_status = input.manualStatus ?? null;
  if (input.showUptime !== undefined) patch.show_uptime = input.showUptime ? 1 : 0;
  return (await ctx.db.update<ComponentRow>('mon_components', id, patch))!;
}

export async function deleteComponent(ctx: Ctx, id: string): Promise<void> {
  if (!(await ctx.db.get('mon_components', id))) throw errors.not_found('We couldn’t find that component.');
  await ctx.db.remove('mon_components', id);
}

/** Save a new order: group ids and component ids, first to last. Unknown ids are ignored. */
export async function reorder(ctx: Ctx, pageId: string, order: { groups?: string[]; components?: string[] }): Promise<void> {
  await getPage(ctx, pageId);
  const stmts: D1PreparedStatement[] = [];
  (order.groups ?? []).slice(0, 100).forEach((id, i) => stmts.push(ctx.env.DB.prepare('UPDATE mon_groups SET position = ?3 WHERE org_id = ?1 AND page_id = ?4 AND id = ?2').bind(ctx.db.orgId, id, i, pageId)));
  (order.components ?? []).slice(0, 100).forEach((id, i) => stmts.push(ctx.env.DB.prepare('UPDATE mon_components SET position = ?3 WHERE org_id = ?1 AND page_id = ?4 AND id = ?2').bind(ctx.db.orgId, id, i, pageId)));
  if (stmts.length) await ctx.env.DB.batch(stmts);
}

/* ------------------------------------------------------------------ public view */

export type ComponentStatus = 'operational' | 'degraded' | 'partial' | 'major' | 'maintenance';
const RANK: Record<ComponentStatus, number> = { operational: 0, maintenance: 1, degraded: 2, partial: 3, major: 4 };
export const STATUS_LABEL: Record<ComponentStatus, string> = {
  operational: 'Operational',
  maintenance: 'Under maintenance',
  degraded: 'Degraded performance',
  partial: 'Partial outage',
  major: 'Major outage',
};

export type BarLevel = 'none' | 'ok' | 'warn' | 'bad';

export interface StatusBar {
  day: string;
  pct: number | null;
  level: BarLevel;
}

export interface StatusComponent {
  id: string;
  name: string;
  description: string | null;
  status: ComponentStatus;
  label: string;
  uptimePct: number | null;
  bars: StatusBar[] | null;
}

export interface StatusIncident {
  id: string;
  title: string;
  status: IncidentRow['status'];
  impact: IncidentRow['impact'];
  startedAt: number;
  resolvedAt: number | null;
  components: string[];
  postmortem: string | null;
  updates: { status: IncidentUpdateRow['status']; body: string; at: number }[];
}

export interface StatusMaintenance {
  id: string;
  title: string;
  body: string | null;
  start: number;
  end: number;
  active: boolean;
}

export interface StatusData {
  page: { id: string; orgId: string; slug: string; title: string; description: string | null; websiteUrl: string | null; customCss: string | null; allowSubscribe: boolean; hideFromSearch: boolean; uptimeDays: number };
  overall: { status: ComponentStatus; text: string };
  groups: { id: string; name: string; collapsed: boolean; components: StatusComponent[] }[];
  loose: StatusComponent[];
  active: StatusIncident[];
  past: StatusIncident[];
  maintenance: StatusMaintenance[];
  generatedAt: number;
}

export const barLevel = (pct: number | null): BarLevel => (pct === null ? 'none' : pct >= 99.5 ? 'ok' : pct >= 97 ? 'warn' : 'bad');

const IMPACT_TO_STATUS = { minor: 'degraded', major: 'partial', critical: 'major' } as const;

export function overallOf(statuses: ComponentStatus[]): { status: ComponentStatus; text: string } {
  let worst: ComponentStatus = 'operational';
  for (const s of statuses) if (RANK[s] > RANK[worst]) worst = s;
  const text = { operational: 'All systems operational', maintenance: 'Scheduled maintenance in progress', degraded: 'Some systems are slow', partial: 'Some systems are down', major: 'Major outage' }[worst];
  return { status: worst, text };
}

/** Build everything the public page, feeds, badge and widget show. Cheap enough to cache for a couple of minutes. */
export async function loadStatus(env: Env, slug: string, at = Date.now()): Promise<StatusData | null> {
  const page = await env.DB.prepare('SELECT * FROM mon_pages WHERE slug = ?1').bind(slug).first<PageRow>();
  if (!page || page.published !== 1) return null;
  const orgId = page.org_id;
  const [groups, comps] = await Promise.all([
    env.DB.prepare('SELECT * FROM mon_groups WHERE org_id = ?1 AND page_id = ?2 ORDER BY position, id').bind(orgId, page.id).all<GroupRow>(),
    env.DB.prepare('SELECT * FROM mon_components WHERE org_id = ?1 AND page_id = ?2 ORDER BY position, id').bind(orgId, page.id).all<ComponentRow>(),
  ]);
  const components = comps.results;
  const monitorIds = [...new Set(components.map((c) => c.monitor_id).filter((x): x is string => !!x))];
  const monitors = new Map<string, MonitorRow>();
  if (monitorIds.length) {
    const qs = monitorIds.map(() => '?').join(',');
    const rows = await env.DB.prepare(`SELECT * FROM mon_monitors WHERE org_id = ?1 AND id IN (${qs})`).bind(orgId, ...monitorIds).all<MonitorRow>();
    for (const m of rows.results) monitors.set(m.id, m);
  }

  const tz = await workspaceZone(env, orgId);
  const mrows = (await env.DB.prepare(`SELECT * FROM mon_maintenance WHERE org_id = ?2 AND (${RELEVANT_SQL})`).bind(at, orgId).all<MaintenanceRow>()).results;
  const activeOcc: Occurrence[] = [];
  const maintenance: StatusMaintenance[] = [];
  for (const m of mrows) {
    const occ = currentOrNext(m, tz, at);
    if (!occ) continue;
    const isActive = occ.start <= at && at < occ.end;
    if (isActive) activeOcc.push(occ);
    // Show it on the page when it is running or starts within a week, and covers something on this page.
    const touches = occ.monitorIds.length === 0 || occ.monitorIds.some((id) => monitorIds.includes(id));
    if (touches && (isActive || occ.start - at < 7 * DAY)) maintenance.push({ id: m.id, title: occ.title, body: occ.body, start: occ.start, end: occ.end, active: isActive });
  }
  maintenance.sort((a, b) => a.start - b.start);

  const incRows = (
    await env.DB.prepare(`SELECT * FROM mon_incidents WHERE org_id = ?1 AND (status != 'resolved' OR resolved_at >= ?2) ORDER BY started_at DESC LIMIT 60`)
      .bind(orgId, at - 14 * DAY)
      .all<IncidentRow>()
  ).results;
  const onPage = new Set(components.map((c) => c.id));
  const nameOf = new Map(components.map((c) => [c.id, c.name]));
  const shown = incRows.filter((i) => {
    const cids = ids(i.component_ids);
    return cids.length ? cids.some((c) => onPage.has(c)) : i.monitor_id === null;
  });
  const updatesBy = new Map<string, IncidentUpdateRow[]>();
  if (shown.length) {
    const qs = shown.map(() => '?').join(',');
    const ups = (await env.DB.prepare(`SELECT * FROM mon_incident_updates WHERE org_id = ?1 AND incident_id IN (${qs}) ORDER BY at DESC, id DESC`).bind(orgId, ...shown.map((i) => i.id)).all<IncidentUpdateRow>()).results;
    for (const u of ups) updatesBy.set(u.incident_id, [...(updatesBy.get(u.incident_id) ?? []), u]);
  }
  const toIncident = (i: IncidentRow): StatusIncident => ({
    id: i.id,
    title: i.title,
    status: i.status,
    impact: i.impact,
    startedAt: i.started_at,
    resolvedAt: i.resolved_at,
    components: ids(i.component_ids).map((c) => nameOf.get(c)).filter((n): n is string => !!n),
    postmortem: i.postmortem,
    updates: (updatesBy.get(i.id) ?? []).map((u) => ({ status: u.status, body: u.body, at: u.at })),
  });
  const active = shown.filter((i) => i.status !== 'resolved').map(toIncident);
  const past = shown.filter((i) => i.status === 'resolved').map(toIncident);

  const impactFor = new Map<string, ComponentStatus>();
  for (const i of shown) {
    if (i.status === 'resolved') continue;
    const s = IMPACT_TO_STATUS[i.impact];
    for (const cid of ids(i.component_ids)) if (RANK[s] > RANK[impactFor.get(cid) ?? 'operational']) impactFor.set(cid, s);
  }

  const days = page.uptime_days;
  const series = await dailySeries(env, orgId, monitorIds, days, at);

  const build = (c: ComponentRow): StatusComponent => {
    let status: ComponentStatus = 'operational';
    const m = c.monitor_id ? monitors.get(c.monitor_id) : undefined;
    if (m) {
      if (isCovered(m.id, activeOcc)) status = 'maintenance';
      else if (m.status === 'down') status = 'major';
      else if (m.slow === 1) status = 'degraded';
    }
    // A manual status is the whole answer for a component with no monitor, and can only make a monitored one look worse.
    if (c.manual_status && status !== 'maintenance' && RANK[c.manual_status] >= RANK[status]) status = c.manual_status;
    const inc = impactFor.get(c.id);
    if (inc && RANK[inc] > RANK[status] && status !== 'maintenance') status = inc;
    let bars: StatusBar[] | null = null;
    let uptimePct: number | null = null;
    if (m && c.show_uptime === 1) {
      const s = series.get(m.id) ?? [];
      bars = s.map(({ day, b }) => {
        const n = b ? b.up + b.down : 0;
        const pct = n ? (b!.up / n) * 100 : null;
        return { day, pct, level: barLevel(pct) };
      });
      uptimePct = summarize(s.map((x) => x.b)).uptimePct;
    }
    return { id: c.id, name: c.name, description: c.description, status, label: STATUS_LABEL[status], uptimePct, bars };
  };

  const built = new Map(components.map((c) => [c.id, build(c)]));
  const groupOut = groups.results.map((g) => ({
    id: g.id,
    name: g.name,
    collapsed: g.collapsed === 1,
    components: components.filter((c) => c.group_id === g.id).map((c) => built.get(c.id)!),
  }));
  const groupIds = new Set(groups.results.map((g) => g.id));
  const loose = components.filter((c) => !c.group_id || !groupIds.has(c.group_id)).map((c) => built.get(c.id)!);

  return {
    page: {
      id: page.id,
      orgId,
      slug: page.slug,
      title: page.title,
      description: page.description,
      websiteUrl: page.website_url,
      customCss: page.custom_css,
      allowSubscribe: page.allow_subscribe === 1,
      hideFromSearch: page.hide_from_search === 1,
      uptimeDays: days,
    },
    overall: overallOf([...built.values()].map((c) => c.status)),
    groups: groupOut,
    loose,
    active,
    past,
    maintenance,
    generatedAt: at,
  };
}

/** Pieces of custom CSS that could load things from elsewhere or close the style tag are dropped. */
export function safeCss(css: string | null): string {
  if (!css) return '';
  return css
    .replace(/<\/?style[^>]*>/gi, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)(?!data:image\/)[^)]*\1\s*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '(')
    .replace(/</g, '\\3c ')
    .slice(0, 20_000);
}
