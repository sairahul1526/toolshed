import { defineModule } from '../../core/module';
import { alertJob } from './alerts';
import api from './api';
import dashboard from './dashboard';
import { eventsJob } from './events';
import { aliveSchedule, clearSampleData, exportData, monitorCount, overview, sampleData } from './ops';
import publicRoutes from './public';
import { dispatchMinute, processChunk } from './runner';
import { notifyBatchJob, notifyJob } from './subscribers';
import { pruneSchedule, rollupSchedule } from './uptime';

export default defineModule({
  id: 'monitor',
  name: 'Monitor',
  description: 'Know when your site or cron job goes down, and tell your users with a status page',
  icon: 'pulse',
  category: 'operations',
  version: '1.0.0',

  nav: [
    { label: 'Incidents', path: 'incidents' },
    { label: 'Status pages', path: 'pages' },
    { label: 'Alerts', path: 'alerts' },
    { label: 'Maintenance', path: 'maintenance' },
    { label: 'Settings', path: 'settings' },
  ],
  permissions: [
    { scope: 'monitor:read', label: 'See monitors, incidents and status pages' },
    { scope: 'monitor:write', label: 'Create and change monitors, alerts, incidents and status pages' },
  ],

  dashboard,
  api,
  public: publicRoutes,
  publicPrefixes: ['/status', '/hb'],

  jobs: {
    events: eventsJob,
    alert: alertJob,
    chunk: processChunk,
    notify: notifyJob,
    notify_batch: notifyBatchJob,
  },
  schedules: [
    { name: 'checks', every: 'minute', run: async (env, at) => void (await dispatchMinute(env, at)) },
    { name: 'alive', every: 'minute', run: aliveSchedule },
    { name: 'rollup', every: 'hour', run: rollupSchedule },
    { name: 'prune', every: 'day', run: pruneSchedule },
  ],
  events: {
    emits: [
      'monitor.down',
      'monitor.recovered',
      'monitor.slow',
      'incident.opened',
      'incident.updated',
      'incident.resolved',
      'maintenance.started',
      'maintenance.ended',
      'subscriber.added',
    ],
  },

  count: monitorCount,
  overview,
  onboarding: { title: 'Watch your first site', body: 'Paste a web address. We check it every minute and tell you when it goes down.' },

  tables: [
    'mon_monitors', 'mon_minutes', 'mon_hourly', 'mon_daily', 'mon_state_changes', 'mon_failures', 'mon_channels', 'mon_alerts',
    'mon_incidents', 'mon_incident_updates', 'mon_maintenance', 'mon_pages', 'mon_groups', 'mon_components', 'mon_subscribers',
  ],
  sampleData,
  clearSampleData,
  exportData,
});
