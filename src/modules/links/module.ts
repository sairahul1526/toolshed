import type { Context } from 'hono';
import type { AppEnv } from '../../env';
import { defineModule, type ModuleContext } from '../../core/module';
import { api } from './api';
import { dashboard } from './dashboard';
import { dayOf, DAY_MS } from './days';
import { countByStatus } from './links';
import { fallback, publicApp } from './public';
import { runExpire, runRollup } from './rollup';
import { addSampleData, removeSampleData } from './sample';
import { countOpenReports } from './abuse';
import type { LinksCtx } from './types';

const TABLES = [
  'links_links', 'links_slugs', 'links_daily', 'links_clicks', 'links_rollups', 'links_link_tags', 'links_folders',
  'links_bios', 'links_bio_blocks', 'links_blocked_domains', 'links_reports',
];

/** Jobs and exports have no request, so the address comes from settings; the tests and dev use localhost. */
function ctxFrom(m: ModuleContext): LinksCtx {
  const base = (m.env.APP_URL?.trim() || 'http://localhost:8787').replace(/\/+$/, '');
  return { env: m.env, orgId: m.org.id, base };
}

async function clicksSince(m: ModuleContext, days: number): Promise<number> {
  const from = dayOf(Date.now() - (days - 1) * DAY_MS);
  const row = await m.env.DB.prepare(`SELECT COALESCE(SUM(clicks), 0) AS n FROM links_daily WHERE org_id = ?1 AND kind = 'click' AND day >= ?2`).bind(m.org.id, from).first<{ n: number }>();
  return row?.n ?? 0;
}

export default defineModule({
  id: 'links',
  name: 'Links',
  description: 'Short links, QR codes, click stats and a bio page',
  icon: 'link',
  category: 'growth',
  version: '1.0.0',
  nav: [
    { label: 'Links', path: '' },
    { label: 'Stats', path: 'stats' },
    { label: 'Bio pages', path: 'bio' },
    { label: 'Import and export', path: 'import' },
    { label: 'Settings', path: 'settings' },
  ],
  permissions: [
    { scope: 'links:read', label: 'See links, stats and bio pages' },
    { scope: 'links:write', label: 'Create and change links and bio pages' },
  ],
  dashboard,
  api,
  public: publicApp,
  publicPrefixes: ['/l'],
  fallback: (c: Context<AppEnv>) => fallback(c),
  schedules: [
    { name: 'rollup', every: 'hour', run: async (env, at) => void (await runRollup(env, at.getTime())) },
    { name: 'expire', every: 'hour', run: async (env, at) => void (await runExpire(env, at.getTime())) },
  ],
  events: {
    emits: ['link.created', 'link.updated', 'link.deleted', 'link.clicked', 'link.expired', 'link.reported', 'bio.updated'],
  },
  count: async (m) => (await countByStatus(ctxFrom(m))).active,
  overview: async (m) => {
    const [week, reports] = await Promise.all([clicksSince(m, 7), countOpenReports(ctxFrom(m))]);
    const stats = [{ label: 'Clicks, last 7 days', value: String(week), href: '/app/links/stats' }];
    if (reports > 0) stats.push({ label: 'Open reports', value: String(reports), href: '/app/links/settings' });
    return stats;
  },
  onboarding: { title: 'Shorten a link', body: 'Paste a long address and get a short link with a QR code, ready to share.' },
  tables: TABLES,
  sampleData: (m) => addSampleData(ctxFrom(m)),
  clearSampleData: (m) => removeSampleData(ctxFrom(m)),
  exportData: async (m) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const { results } = await m.env.DB.prepare(`SELECT * FROM ${table} WHERE org_id = ?1 LIMIT 20000`).bind(m.org.id).all<Record<string, unknown>>();
      out[table] = table === 'links_links' ? results.map(({ password_hash, ...rest }) => ({ ...rest, has_password: Boolean(password_hash) })) : results;
    }
    return out;
  },
});
