import { defineModule, type ModuleContext } from '../../core/module';
import { api } from './api';
import { dashboard } from './dashboard';
import { runBatch, watchdog, type BatchPayload } from './engine';
import { publicApp } from './public';
import { checkDueFeeds } from './rss';
import { addSampleData, removeSampleData } from './sample';
import { runSequences } from './sequences';
import { totals } from './stats';

const TABLES = [
  'mail_lists', 'mail_subscribers', 'mail_subscriber_tags', 'mail_memberships', 'mail_suppressions', 'mail_fields', 'mail_segments',
  'mail_broadcasts', 'mail_deliveries', 'mail_links', 'mail_sequences', 'mail_sequence_steps', 'mail_enrollments', 'mail_templates',
  'mail_sent', 'mail_feeds', 'mail_feed_items',
];

export default defineModule({
  id: 'mail',
  name: 'Mail',
  description: 'Newsletters, welcome emails and product emails to your own list',
  icon: 'mail',
  category: 'growth',
  version: '1.0.0',
  nav: [
    { label: 'Broadcasts', path: '' },
    { label: 'Newsletters', path: 'lists' },
    { label: 'Subscribers', path: 'subscribers' },
    { label: 'Segments', path: 'segments' },
    { label: 'Welcome emails', path: 'sequence' },
    { label: 'Product emails', path: 'templates' },
    { label: 'RSS to email', path: 'feeds' },
    { label: 'Stats', path: 'stats' },
    { label: 'Deliverability', path: 'deliverability' },
    { label: 'Settings', path: 'settings' },
  ],
  permissions: [
    { scope: 'mail:read', label: 'See newsletters, subscribers and stats' },
    { scope: 'mail:write', label: 'Create and change newsletters, subscribers and templates' },
    { scope: 'mail:send', label: 'Send and schedule emails' },
  ],
  api,
  dashboard,
  public: publicApp,
  publicPrefixes: ['/n'],
  jobs: {
    'send-batch': async (env, payload) => void (await runBatch(env, payload as BatchPayload)),
  },
  schedules: [
    { name: 'watchdog', every: 'minute', run: async (env, at) => void (await watchdog(env, at.getTime())) },
    { name: 'sequences', every: 'minute', run: async (env, at) => void (await runSequences(env, at.getTime())) },
    { name: 'feeds', every: 'hour', run: async (env, at) => void (await checkDueFeeds(env, at.getTime())) },
  ],
  events: {
    emits: [
      'subscriber.created', 'subscriber.confirmed', 'subscriber.unsubscribed', 'subscriber.bounced',
      'broadcast.scheduled', 'broadcast.sent', 'broadcast.failed', 'email.sent', 'sequence.completed',
    ],
  },
  count: async (m) => (await totals(m)).active,
  overview: async (m: ModuleContext) => {
    const t = await totals(m);
    return [
      { label: 'Subscribers', value: String(t.active), href: '/app/mail/subscribers' },
      { label: 'Waiting to confirm', value: String(t.pending), href: '/app/mail/subscribers?status=pending' },
    ];
  },
  onboarding: { title: 'Start a newsletter', body: 'Set up a signup page, write an issue and send it to people who asked for it.' },
  tables: TABLES,
  sampleData: (m) => addSampleData(m),
  clearSampleData: (m) => removeSampleData(m),
  exportData: async (m) => {
    const out: Record<string, unknown[]> = {};
    for (const table of TABLES) {
      const { results } = await m.env.DB.prepare(`SELECT * FROM ${table} WHERE org_id = ?1 LIMIT 20000`).bind(m.org.id).all<Record<string, unknown>>();
      out[table] = results;
    }
    return out;
  },
});
