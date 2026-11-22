import { describe, expect, it, vi } from 'vitest';
import { createMonitor, getMonitor } from '../../src/modules/monitor/monitors';
import { dispatchMinute, INLINE_MAX } from '../../src/modules/monitor/runner';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, fakeSite, MIN, T0, useModule } from './helpers';

useModule();

async function setup() {
  const t = createTestEnv();
  const ctx = await ctxOf(t);
  const m = await createMonitor(ctx, { name: 'Site', url: 'https://example.com/health', failAfter: 2 }, { at: T0 });
  return { t, ctx, m };
}

describe('runner', () => {
  it('counts a failed check, waits for the second, then declares down and opens an incident', async () => {
    const { t, ctx, m } = await setup();
    const site = fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('pending');
    expect((await getMonitor(ctx, m.id)).fail_streak).toBe(1);
    await dispatchMinute(t.env, T0 + 2 * MIN);
    await t.drainJobs();
    const down = await getMonitor(ctx, m.id);
    expect(down.status).toBe('down');
    const incidents = await ctx.db.all<{ title: string; status: string }>('SELECT * FROM mon_incidents WHERE org_id = :org');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]!.status).toBe('investigating');
    expect(site.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not alert on a single blip: a failed first look that passes the second look counts as up', async () => {
    const { t, ctx, m } = await setup();
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (n++ === 0 ? new Response('no', { status: 503 }) : new Response('ok'))));
    await dispatchMinute(t.env, T0 + MIN);
    await t.drainJobs();
    const row = await getMonitor(ctx, m.id);
    expect(row.status).toBe('up');
    expect(row.fail_streak).toBe(0);
  });

  it('recovers: closes the incident and records the recovery once', async () => {
    const { t, ctx, m } = await setup();
    const site = fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN);
    await dispatchMinute(t.env, T0 + 2 * MIN);
    await t.drainJobs();
    site.status = 200;
    await dispatchMinute(t.env, T0 + 3 * MIN);
    await t.drainJobs();
    expect((await getMonitor(ctx, m.id)).status).toBe('up');
    const incident = await ctx.db.all<{ status: string; resolved_at: number | null }>('SELECT * FROM mon_incidents WHERE org_id = :org');
    expect(incident[0]!.status).toBe('resolved');
    expect(incident[0]!.resolved_at).not.toBeNull();
  });

  it('checks the keyword and the expected status', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    const m = await createMonitor(ctx, { name: 'Kw', url: 'https://example.com/', keyword: 'Welcome', keywordMode: 'present', failAfter: 1 }, { at: T0 });
    fakeSite({ body: 'Hello' });
    await dispatchMinute(t.env, T0 + MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('down');
    fakeSite({ body: 'Welcome home' });
    await dispatchMinute(t.env, T0 + 2 * MIN);
    expect((await getMonitor(ctx, m.id)).status).toBe('up');
  });

  it('keeps state frozen and skips alerts during a maintenance window', async () => {
    const { t, ctx, m } = await setup();
    const { createMaintenance } = await import('../../src/modules/monitor/maintenance');
    await createMaintenance(ctx, { title: 'Upgrade', startsAt: T0, durationMin: 120, monitorIds: [m.id] }, { at: T0 });
    fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN);
    await dispatchMinute(t.env, T0 + 2 * MIN);
    await t.drainJobs();
    const row = await getMonitor(ctx, m.id);
    expect(row.status).not.toBe('down');
    expect(await ctx.db.count('mon_incidents')).toBe(0);
  });

  it('runs a bounded number of checks per cron tick and queues the rest in chunks', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    for (let i = 0; i < INLINE_MAX + 5; i++) await createMonitor(ctx, { name: `M${i}`, url: `https://example.com/${i}`, intervalMin: 1 }, { at: T0 });
    fakeSite();
    const res = await dispatchMinute(t.env, T0 + MIN);
    expect(res.checked).toBe(INLINE_MAX);
    expect(res.queued).toBe(1);
    await t.drainJobs();
    const stored = await ctx.db.all<{ chunk: string }>('SELECT chunk FROM mon_minutes WHERE org_id = :org');
    expect(stored.map((r) => r.chunk).sort()).toEqual(['0', 'c1']);
  });

  it('never checks sample monitors or paused monitors', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await createMonitor(ctx, { name: 'Sample', url: 'https://example.com/s' }, { at: T0, sample: true });
    const paused = await createMonitor(ctx, { name: 'Paused', url: 'https://example.com/p' }, { at: T0 });
    await ctx.db.update('mon_monitors', paused.id, { paused: 1 });
    const site = fakeSite();
    await dispatchMinute(t.env, T0 + MIN);
    expect(site.calls).toHaveLength(0);
  });

  it('refuses to check addresses on a private network', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await expect(createMonitor(ctx, { name: 'Local', url: 'http://192.168.1.5/' })).rejects.toMatchObject({ code: 'monitor.url_not_allowed' });
    await expect(createMonitor(ctx, { name: 'Local', url: 'http://localhost:8787/' })).rejects.toMatchObject({ code: 'monitor.url_not_allowed' });
  });
});
