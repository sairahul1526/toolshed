import { describe, expect, it, vi } from 'vitest';
import { recordPing } from '../../src/modules/monitor/heartbeats';
import { createMonitor, getMonitor, monitorView } from '../../src/modules/monitor/monitors';
import { dispatchMinute } from '../../src/modules/monitor/runner';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, MIN, T0, useModule } from './helpers';

useModule();

async function setup() {
  const t = createTestEnv();
  const ctx = await ctxOf(t);
  const m = await createMonitor(ctx, { name: 'Nightly backup', type: 'heartbeat', hbPeriodSec: 3600, hbGraceSec: 300 }, { at: T0 });
  return { t, ctx, m, token: m.hb_token! };
}

describe('heartbeats', () => {
  it('stays pending until the first ping, then up', async () => {
    const { t, ctx, m, token } = await setup();
    await dispatchMinute(t.env, T0 + MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('pending');
    expect(await recordPing(t.env, token, 'success', { at: T0 + 2 * MIN })).toBe('ok');
    await dispatchMinute(t.env, T0 + 3 * MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('up');
  });

  it('goes down when the ping is later than the period plus the grace time', async () => {
    const { t, ctx, m, token } = await setup();
    await recordPing(t.env, token, 'success', { at: T0 });
    await dispatchMinute(t.env, T0 + MIN);
    await dispatchMinute(t.env, T0 + 3600_000 + 4 * MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('up');
    await dispatchMinute(t.env, T0 + 3600_000 + 6 * MIN);
    await t.drainJobs();
    expect((await getMonitor(ctx, m.id)).status).toBe('down');
    await recordPing(t.env, token, 'success', { at: T0 + 3600_000 + 7 * MIN });
    await dispatchMinute(t.env, T0 + 3600_000 + 8 * MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('up');
  });

  it('treats a fail ping as an immediate failure and keeps the note', async () => {
    const { t, ctx, m, token } = await setup();
    await recordPing(t.env, token, 'success', { at: T0 });
    await dispatchMinute(t.env, T0 + MIN);
    await recordPing(t.env, token, 'fail', { at: T0 + 2 * MIN, code: 2, note: 'disk full' });
    await dispatchMinute(t.env, T0 + 3 * MIN);
    const row = await getMonitor(ctx, m.id);
    expect(row.status).toBe('down');
    expect(monitorView(row, 'http://localhost').heartbeat?.lastNote).toBe('disk full');
  });

  it('rejects unknown tokens and limits pings to 12 a minute', async () => {
    const { t, token } = await setup();
    expect(await recordPing(t.env, 'x'.repeat(24), 'success')).toBe('unknown');
    expect(await recordPing(t.env, 'short', 'success')).toBe('unknown');
    const results: string[] = [];
    for (let i = 0; i < 14; i++) results.push(await recordPing(t.env, token, 'success', { at: T0 + 5 * MIN }));
    expect(results.filter((r) => r === 'ok')).toHaveLength(12);
    expect(results.filter((r) => r === 'limited')).toHaveLength(2);
  });
});
