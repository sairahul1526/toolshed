import { once } from '../../core/jobs';
import { defineModule } from '../../core/module';
import { orgDb } from '../../core/db';
import { buildApi } from './api';
import { publishDue, queueDigest } from './changelog';
import { sendAdminDigest } from './digest';
import { EVENTS } from './events';
import { exportAll } from './exportimport';
import { runNotice } from './notify';
import { emailStatus } from '../../core/email';
import { clearSample, seedSample } from './sample';
import type { Ctx } from './portal';
import { dashboard } from './dashboard';
import { publicRoutes } from './public';

const ctxOf = (m: { env: import('../../env').Env; org: { id: string } }): Ctx => ({ env: m.env, orgId: m.org.id, db: orgDb(m.env.DB, m.org.id) });

export default defineModule({
  id: 'feedback',
  name: 'Feedback',
  description: 'Feature voting, a public roadmap and a changelog, with emails that close the loop',
  icon: 'msg',
  category: 'product',
  version: '1.0.0',
  nav: [
    { label: 'Inbox', path: '' },
    { label: 'Roadmap', path: 'roadmap' },
    { label: 'Changelog', path: 'changelog' },
    { label: 'Stats', path: 'stats' },
    { label: 'Settings', path: 'settings' },
  ],
  permissions: [
    { scope: 'feedback:read', label: 'Read posts, comments, votes and the changelog' },
    { scope: 'feedback:write', label: 'Change posts, statuses, comments and changelog entries' },
  ],
  dashboard,
  api: buildApi(),
  public: publicRoutes,
  publicPrefixes: ['/feedback', '/roadmap', '/changelog'],
  tables: [
    'fb_portals', 'fb_boards', 'fb_categories', 'fb_statuses', 'fb_tags', 'fb_people', 'fb_posts', 'fb_post_tags', 'fb_votes', 'fb_comments', 'fb_notes',
    'fb_status_log', 'fb_entries', 'fb_entry_posts', 'fb_images', 'fb_subscribers', 'fb_codes', 'fb_outbox', 'fb_deliveries',
  ],
  jobs: {
    notify: async (env, payload) => {
      const p = payload as { orgId: string; outboxId: string };
      await runNotice(env, p.orgId, p.outboxId);
    },
  },
  schedules: [
    { name: 'publish-due', every: 'minute', run: async (env, at) => void (await publishDue(env, at.getTime())) },
    {
      name: 'housekeeping',
      every: 'day',
      run: async (env, at) => {
        const now = at.getTime();
        // Trend scores fade so "trending" favours recent votes; expired sign-in codes and old delivery rows go.
        await env.DB.batch([
          env.DB.prepare('UPDATE fb_posts SET trend = trend * 0.85 WHERE trend > 0.01'),
          env.DB.prepare('UPDATE fb_posts SET trend = 0 WHERE trend <= 0.01 AND trend != 0'),
          env.DB.prepare('DELETE FROM fb_codes WHERE expires_at < ?1').bind(now - 24 * 3600 * 1000),
          env.DB.prepare("DELETE FROM fb_deliveries WHERE outbox_id IN (SELECT id FROM fb_outbox WHERE state != 'sending' AND created_at < ?1)").bind(now - 60 * 24 * 3600 * 1000),
          env.DB.prepare("DELETE FROM fb_outbox WHERE state != 'sending' AND created_at < ?1").bind(now - 60 * 24 * 3600 * 1000),
        ]);
      },
    },
    {
      name: 'weekly-mail',
      every: 'hour',
      run: async (env, at) => {
        // Mondays around 04:00 UTC; the claim key keeps a retry or a second worker from sending twice.
        if (at.getUTCDay() !== 1 || at.getUTCHours() !== 4) return;
        const day = at.toISOString().slice(0, 10);
        const { results } = await env.DB.prepare('SELECT * FROM fb_portals').all<import('./types').Portal>();
        for (const portal of results) {
          await once(env, `feedback:weekly:${portal.org_id}:${day}`, 7 * 24 * 3600, async () => {
            await sendAdminDigest(env, portal, at.getTime());
            await queueDigest(env, portal.org_id, 'weekly', at.getTime());
          });
        }
      },
    },
    {
      name: 'monthly-digest',
      every: 'day',
      run: async (env, at) => {
        if (at.getUTCDate() !== 1) return;
        const day = at.toISOString().slice(0, 10);
        const { results } = await env.DB.prepare('SELECT org_id FROM fb_portals').all<{ org_id: string }>();
        for (const r of results) await once(env, `feedback:monthly:${r.org_id}:${day}`, 7 * 24 * 3600, () => queueDigest(env, r.org_id, 'monthly', at.getTime()));
      },
    },
  ],
  events: { emits: EVENTS },
  setup: async ({ env }) =>
    ((await emailStatus(env)).status === 'ready')
      ? { status: 'ready' }
      : {
          status: 'ready',
          reason: 'Email is not set up, so visitors cannot sign in with a code and posts from guests are held for your approval. Set up email to turn that off.',
          action: { label: 'Set up email', href: '/app/email' },
        },
  count: async (m) => {
    const row = await orgDb(m.env.DB, m.org.id).first<{ n: number }>("SELECT COUNT(*) AS n FROM fb_posts WHERE org_id = :org AND review = 'pending'");
    return row?.n || null;
  },
  overview: async (m) => {
    const db = orgDb(m.env.DB, m.org.id);
    const [posts, votes] = await Promise.all([
      db.first<{ n: number }>("SELECT COUNT(*) AS n FROM fb_posts WHERE org_id = :org AND review = 'published'"),
      db.first<{ n: number }>("SELECT COALESCE(SUM(vote_count), 0) AS n FROM fb_posts WHERE org_id = :org AND review = 'published'"),
    ]);
    return [
      { label: 'Feedback posts', value: String(posts?.n ?? 0), href: '/app/feedback' },
      { label: 'Votes', value: String(votes?.n ?? 0), href: '/app/feedback' },
    ];
  },
  onboarding: { title: 'Collect feedback', body: 'Open a public board where customers vote on ideas, then show a roadmap and a changelog.' },
  sampleData: seedSample,
  clearSampleData: clearSample,
  exportData: async (m) => exportAll(ctxOf(m)),
});
