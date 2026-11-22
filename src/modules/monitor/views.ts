/** Plain objects for the API and screens. */
import { parseJson } from '../../core/db';
import type { ComponentRow, GroupRow, MaintenanceRow, PageRow } from './schema';
import { ids } from './schema';

export const maintenanceView = (m: MaintenanceRow) => ({
  id: m.id,
  title: m.title,
  body: m.body,
  startsAt: m.starts_at,
  durationMin: m.duration_min,
  recurrence: m.recurrence,
  recurUntil: m.recur_until,
  monitorIds: parseJson<string[]>(m.monitor_ids, []),
  notify: m.notify === 1,
  createdAt: m.created_at,
});

export const pageView = (p: PageRow, base: string) => ({
  id: p.id,
  slug: p.slug,
  title: p.title,
  description: p.description,
  websiteUrl: p.website_url,
  customCss: p.custom_css,
  published: p.published === 1,
  hideFromSearch: p.hide_from_search === 1,
  allowSubscribe: p.allow_subscribe === 1,
  uptimeDays: p.uptime_days,
  url: `${base}/status/${p.slug}`,
  createdAt: p.created_at,
});

export const groupView = (g: GroupRow) => ({ id: g.id, pageId: g.page_id, name: g.name, position: g.position, collapsed: g.collapsed === 1 });

export const componentView = (c: ComponentRow) => ({
  id: c.id,
  pageId: c.page_id,
  groupId: c.group_id,
  name: c.name,
  description: c.description,
  monitorId: c.monitor_id,
  manualStatus: c.manual_status,
  position: c.position,
  showUptime: c.show_uptime === 1,
});


