import { enqueue } from '../../core/jobs';
import { defineModule } from '../../core/module';
import { formatNumber } from '../../ui/format';
import api from './api';
import { dashboard } from './dashboard';
import { exportData } from './export';
import { alertJob, hourlyJob, pruneJob, purgeJob, reportJob } from './jobs';
import publicRoutes from './public';
import { clearSampleData, sampleData } from './sample';
import { listSites } from './sites';
import { siteCards } from './stats';

export const TABLES = ['an_sites', 'an_hits', 'an_sessions', 'an_rollups', 'an_goals', 'an_shares', 'an_counters'];

export default defineModule({
  id: 'analytics',
  name: 'Analytics',
  description: 'See who visits your sites, without cookies or consent banners',
  icon: 'chart',
  category: 'insights',
  version: '0.1.0',

  permissions: [
    { scope: 'analytics:read', label: 'Read sites and stats' },
    { scope: 'analytics:write', label: 'Change sites, goals and share links, and send events' },
  ],

  nav: [
    { label: 'All sites', path: '' },
    { label: 'Add a site', path: 'new' },
  ],
  dashboard,
  api,
  public: publicRoutes,
  publicPrefixes: ['/a'],

  jobs: {
    hourly: (env, payload) => hourlyJob(env, payload),
    prune: (env, payload) => pruneJob(env, payload),
    purge: (env, payload) => purgeJob(env, payload),
    report: (env, payload) => reportJob(env, payload),
    alert: (env, payload) => alertJob(env, payload),
  },
  // The schedules only queue the work: one run looks after a few sites and queues the next.
  schedules: [
    { name: 'hourly', every: 'hour', run: (env) => enqueue(env, 'analytics.hourly', {}) },
    { name: 'prune', every: 'day', run: (env) => enqueue(env, 'analytics.prune', {}) },
  ],
  events: { emits: ['site.created', 'goal.completed', 'traffic.spike', 'report.sent'] },

  async setup(ctx) {
    if ((await ctx.db.count('an_sites')) > 0) return { status: 'ready' };
    return { status: 'needs_setup', reason: 'Add a site and paste one line into its pages.', action: { label: 'Add a site', href: '/app/analytics/new' } };
  },
  count: (ctx) => ctx.db.count('an_sites'),
  async overview(ctx) {
    const cards = await siteCards(ctx.db, await listSites(ctx.db));
    if (!cards.length) return [];
    const visitors = cards.reduce((sum, c) => sum + c.visitorsToday, 0);
    const before = cards.reduce((sum, c) => sum + c.visitorsYesterday, 0);
    return [
      { label: 'Visitors today', value: formatNumber(visitors), delta: `${formatNumber(before)} yesterday`, href: '/app/analytics' },
      { label: 'Page views today', value: formatNumber(cards.reduce((sum, c) => sum + c.pageviewsToday, 0)), href: '/app/analytics' },
    ];
  },
  onboarding: { title: 'See who visits your site', body: 'Add your site, paste one line, and watch the first visit arrive.', href: '/app/analytics/new' },

  tables: TABLES,
  sampleData: (ctx) => sampleData(ctx),
  clearSampleData,
  exportData,
});
