import { parseJson } from '../../core/db';
import { emailReady } from '../../core/email';
import { defineModule } from '../../core/module';
import { api } from './api';
import { dashboard } from './dashboard';
import { notifyJob } from './notify';
import { publicApp } from './public';
import { addSampleForms, clearSampleForms } from './sample';
import { countForms, purgeSnapshots, type Ctx } from './service';
import { purgeStats } from './stats';
import { purgeOldJunk } from './submissions';
import { purgeOrphanUploads } from './uploads';

const TABLES = ['forms_forms', 'forms_versions', 'forms_submissions', 'forms_notes', 'forms_files', 'forms_stats'];
const DAY = 86_400_000;

export default defineModule({
  id: 'forms',
  name: 'Forms',
  description: 'Forms and surveys that collect responses, files and scores',
  icon: 'form',
  category: 'growth',
  version: '1.0.0',
  nav: [{ label: 'All forms', path: '' }],
  permissions: [
    { scope: 'forms:read', label: 'See forms and responses' },
    { scope: 'forms:write', label: 'Create and edit forms, and manage responses' },
  ],
  dashboard,
  api,
  public: publicApp,
  publicPrefixes: ['/f'],
  jobs: { notify: (env, payload) => notifyJob(env, payload) },
  schedules: [
    { name: 'forms.snapshots', every: 'day', run: (env, at) => purgeSnapshots(env, at.getTime()) },
    { name: 'forms.junk', every: 'day', run: async (env, at) => void (await purgeOldJunk(env, at.getTime())) },
    { name: 'forms.uploads', every: 'hour', run: async (env, at) => void (await purgeOrphanUploads(env, at.getTime())) },
    { name: 'forms.stats', every: 'day', run: (env, at) => purgeStats(env, at.getTime()) },
  ],
  events: { emits: ['form.submitted', 'form.partial', 'form.published', 'form.closed', 'submission.spam'] },
  setup: async ({ env }) =>
    (await emailReady(env))
      ? { status: 'ready' }
      : { status: 'ready', reason: 'Email is not set up yet, so notifications and autoresponders will not send.', action: { label: 'Set up email', href: '/app/email' } },
  count: async ({ db }) => countForms(db),
  overview: async ({ db }) => {
    const row = await db.first<{ n: number; live: number }>(
      `SELECT COALESCE(SUM(response_count), 0) AS n, SUM(CASE WHEN status = 'live' THEN 1 ELSE 0 END) AS live FROM forms_forms WHERE org_id = :org AND trashed_at IS NULL`,
    );
    return [
      { label: 'Responses', value: String(row?.n ?? 0), href: '/app/forms' },
      { label: 'Live forms', value: String(row?.live ?? 0), href: '/app/forms' },
    ];
  },
  onboarding: { title: 'Collect responses with a form', body: 'Start from a template: contact, feedback, event sign-up or a waitlist.' },
  tables: TABLES,
  sampleData: async ({ env, db }) => addSampleForms({ env, db } satisfies Ctx),
  clearSampleData: async ({ env, db }) => clearSampleForms({ env, db } satisfies Ctx),
  exportData: async ({ db }) => {
    const out: Record<string, unknown[]> = {};
    for (const t of TABLES) {
      const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${t} WHERE org_id = :org`);
      out[t] =
        t === 'forms_forms'
          ? rows.map((r) => {
              const s = parseJson<Record<string, unknown>>(r.settings as string, {});
              delete s.passwordHash;
              return { ...r, settings: JSON.stringify(s) };
            })
          : rows;
    }
    return out;
  },
});
