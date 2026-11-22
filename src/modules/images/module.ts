import { defineModule, type ModuleContext } from '../../core/module';
import { api } from './api';
import { runBatch } from './batch';
import { dashboard } from './dashboard';
import { pub } from './public';
import { runPurge } from './purge';
import { addSample, clearSample } from './sample';
import { pruneUsage, rollupHits, usageSummary } from './usage';

const TABLES = ['img_templates', 'img_assets', 'img_renders', 'img_hits', 'img_log', 'img_daily', 'img_batches'];
/** Rows per table in an export. Templates, uploads and batches always fit; the oldest log lines and stored-image rows may not. */
const EXPORT_ROWS = 5000;
/** Newest first where a table has an id that sorts by time, so a cut-off export keeps the recent rows. */
const EXPORT_ORDER: Record<string, string> = { img_hits: 'day DESC, hash', img_daily: 'day DESC, template_id' };

async function exportData(ctx: ModuleContext): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of TABLES) {
    out[table] = await ctx.db.all(`SELECT * FROM ${table} WHERE org_id = :org ORDER BY ${EXPORT_ORDER[table] ?? 'id DESC'} LIMIT ${EXPORT_ROWS}`);
  }
  return out;
}

export default defineModule({
  id: 'images',
  name: 'Images',
  description: 'Social cards and templated graphics from a URL',
  icon: 'image',
  category: 'content',
  version: '1.0.0',
  nav: [
    { label: 'Templates', path: '' },
    { label: 'Assets', path: 'assets' },
    { label: 'Batch', path: 'batch' },
    { label: 'Usage', path: 'usage' },
    { label: 'Settings', path: 'settings' },
  ],
  permissions: [
    { scope: 'images:read', label: 'See templates, uploads and usage' },
    { scope: 'images:write', label: 'Change templates and make images' },
  ],
  dashboard,
  api,
  public: pub,
  publicPrefixes: ['/i'],
  jobs: {
    batch: (env, payload) => runBatch(env, payload),
    purge: (env, payload) => runPurge(env, payload),
  },
  schedules: [
    { name: 'images.rollup', every: 'hour', run: (env, at) => rollupHits(env, at.getTime()) },
    { name: 'images.prune', every: 'day', run: (env, at) => pruneUsage(env, at.getTime()) },
  ],
  events: { emits: ['template.created', 'template.updated', 'render.completed', 'batch.completed', 'quota.reached'] },
  tables: TABLES,
  setup: async () => ({ status: 'ready' }),
  count: (ctx) => ctx.db.count('img_templates'),
  overview: async (ctx) => {
    const { totals } = await usageSummary(ctx.db, { days: 30 });
    return [
      { label: 'New images (30 days)', value: totals.renders.toLocaleString('en-US'), href: '/app/images/usage' },
      { label: 'Images served from cache (30 days)', value: totals.hits.toLocaleString('en-US'), href: '/app/images/usage' },
    ];
  },
  onboarding: {
    title: 'Make share images from a template',
    body: 'Pick a starter card, change the title, and copy an image URL or the meta tags for your site.',
    href: '/app/images',
  },
  sampleData: (ctx) => addSample(ctx),
  clearSampleData: clearSample,
  exportData,
});
