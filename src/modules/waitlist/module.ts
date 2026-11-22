import { defineModule, type KpiStat } from '../../core/module';
import { emailStatus } from '../../core/email';
import { api } from './api';
import { dashboard } from './dash';
import { jobs, schedules } from './jobs';
import { publicApp } from './public';
import { addSampleWaitlist, clearSampleWaitlists } from './sample';
import { EVENT_NAMES } from './types';

const TABLES = ['wl_waitlists', 'wl_signups', 'wl_tiers', 'wl_reached', 'wl_waves', 'wl_broadcasts', 'wl_daily'];

export default defineModule({
  id: 'waitlist',
  name: 'Waitlist',
  description: 'Collect signups before launch, let people move up by inviting friends, and let them in in waves',
  icon: 'users',
  category: 'growth',
  version: '0.1.0',
  nav: [
    { label: 'Signups', path: 'people' },
    { label: 'Review', path: 'review' },
    { label: 'Launch', path: 'launch' },
    { label: 'Stats', path: 'stats' },
  ],
  permissions: [
    { scope: 'waitlist:read', label: 'Read waitlists, signups and stats' },
    { scope: 'waitlist:write', label: 'Create waitlists, change signups, send invites and broadcasts' },
  ],
  dashboard,
  api,
  public: publicApp,
  publicPrefixes: ['/w'],
  jobs,
  schedules,
  events: { emits: EVENT_NAMES.map((n) => n) },
  tables: TABLES,
  onboarding: { title: 'Start a waitlist', body: 'Make a signup page with a referral link for each person, then let people in when you are ready.' },

  async setup({ env }) {
    const mail = await emailStatus(env);
    if (mail.status === 'ready') return { status: 'ready' };
    return { status: 'needs_setup', reason: 'Email is not set up. Signups still work, but they stay unconfirmed and no one gets emails.', action: mail.action };
  },

  async count({ db }) {
    const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND is_test = 0 AND status NOT IN ('removed')`);
    return row?.n ?? 0;
  },

  async overview({ db }) {
    const week = Date.now() - 7 * 86_400_000;
    const row = await db.first<{ total: number; recent: number; held: number }>(
      `SELECT COUNT(*) AS total, COALESCE(SUM(created_at >= ?), 0) AS recent, COALESCE(SUM(status = 'flagged'), 0) AS held FROM wl_signups WHERE org_id = :org AND is_test = 0 AND status != 'removed'`,
      week,
    );
    const stats: KpiStat[] = [
      { label: 'On waitlists', value: String(row?.total ?? 0), delta: `${row?.recent ?? 0} this week` },
    ];
    if (row?.held) stats.push({ label: 'Waiting for review', value: String(row.held), href: '/app/waitlist/review' });
    return stats;
  },

  sampleData: addSampleWaitlist,
  clearSampleData: clearSampleWaitlists,

  async exportData({ db }) {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const rows = await db.all<Record<string, unknown>>(`SELECT * FROM ${table} WHERE org_id = :org LIMIT 50000`);
      // The token opens a person's private status page, so it is not part of an export.
      out[table] = table === 'wl_signups' ? rows.map(({ token: _token, ...rest }) => rest) : rows;
    }
    return out;
  },
});
