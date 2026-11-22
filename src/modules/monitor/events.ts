/** Queue job `monitor.events`: act on state changes the runner saw (incident, event, alerts). */
import { emit } from '../../core/events';
import { once } from '../../core/jobs';
import { moduleContext } from '../../core/registry';
import type { Env } from '../../env';
import { fanout } from './alerts';
import { openForMonitor, resolveForMonitor } from './incidents';
import type { EventItem } from './runner';
import type { MonitorRow } from './schema';

export async function eventsJob(env: Env, payload: unknown): Promise<void> {
  const { orgId, items } = payload as { orgId: string; items: EventItem[] };
  const ctx = await moduleContext(env, orgId);
  for (const item of items) {
    await once(env, `mon:ev:${item.monitorId}:${item.at}`, 3600, async () => {
      const m = await ctx.db.get<MonitorRow>('mon_monitors', item.monitorId);
      if (!m) return;
      const data = { name: m.name, url: m.url, error: item.error, statusCode: item.code, responseMs: item.ms };
      for (const ev of item.events) {
        if (ev === 'down') {
          const incident = await openForMonitor(ctx, m, item.error, item.at);
          await emit(env, { orgId, module: 'monitor', name: 'monitor.down', subject: m.id, data: { ...data, incidentId: incident?.id ?? null }, at: item.at });
          await fanout(env, orgId, m, 'down', { at: item.at, error: item.error, code: item.code, incidentId: incident?.id ?? null });
        } else if (ev === 'up') {
          await resolveForMonitor(ctx, m, item.at);
          await emit(env, { orgId, module: 'monitor', name: 'monitor.recovered', subject: m.id, data, at: item.at });
          await fanout(env, orgId, m, 'up', { at: item.at });
        } else if (ev === 'slow') {
          await emit(env, { orgId, module: 'monitor', name: 'monitor.slow', subject: m.id, data, at: item.at });
          await fanout(env, orgId, m, 'slow', { at: item.at, ms: item.ms });
        }
      }
    });
  }
}
