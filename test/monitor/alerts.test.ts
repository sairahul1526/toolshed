import { describe, expect, it, vi } from 'vitest';
import { createChannel, updateChannel } from '../../src/modules/monitor/channels';
import { createMonitor } from '../../src/modules/monitor/monitors';
import { dispatchMinute } from '../../src/modules/monitor/runner';
import { setSetting } from '../../src/core/settings';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, fakeSite, MIN, T0, useModule } from './helpers';

useModule();

const alertsOf = (ctx: Awaited<ReturnType<typeof ctxOf>>) => ctx.db.all<{ kind: string; outcome: string; detail: string | null }>('SELECT * FROM mon_alerts WHERE org_id = :org ORDER BY at ASC, rowid ASC');

async function setup(channelExtra: Record<string, unknown> = {}) {
  const t = createTestEnv();
  const ctx = await ctxOf(t);
  const channel = await createChannel(ctx, { name: 'Hook', kind: 'webhook', config: { url: 'https://hooks.example.com/x', secret: 's3cret' }, ...channelExtra });
  const m = await createMonitor(ctx, { name: 'Site', url: 'https://example.com/', failAfter: 1 }, { at: T0 });
  return { t, ctx, channel, m };
}

describe('alerts', () => {
  it('sends down and recovery to a webhook, signed with the secret', async () => {
    const { t, ctx } = await setup();
    const site = fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN);
    await t.drainJobs();
    site.status = 200;
    await dispatchMinute(t.env, T0 + 2 * MIN);
    await t.drainJobs();
    const hookCalls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => String(c[0]).startsWith('https://hooks.example.com'));
    expect(hookCalls).toHaveLength(2);
    const headers = new Headers((hookCalls[0]![1] as RequestInit).headers);
    expect(headers.get('x-toolshed-signature')).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect((await alertsOf(ctx)).map((a) => `${a.kind}:${a.outcome}`)).toEqual(['down:sent', 'up:sent']);
  });

  it('does not send a recovery to a channel that never heard about the outage', async () => {
    const { t, ctx, channel } = await setup({ notifyRecovery: true });
    const site = fakeSite({ status: 500 });
    await updateChannel(ctx, channel.id, { enabled: false });
    await dispatchMinute(t.env, T0 + MIN);
    await t.drainJobs();
    await updateChannel(ctx, channel.id, { enabled: true });
    site.status = 200;
    await dispatchMinute(t.env, T0 + 2 * MIN);
    await t.drainJobs();
    expect((await alertsOf(ctx)).filter((a) => a.outcome === 'sent')).toHaveLength(0);
  });

  it('holds alerts during quiet hours and sends the first one when they end', async () => {
    const { t, ctx } = await setup({ quietFrom: '09:00', quietTo: '11:00' });
    await setSetting(t.env, t.org.id, 'timezone', 'UTC');
    fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN); // 10:01 UTC, inside quiet hours
    await t.drainJobs();
    expect((await alertsOf(ctx)).map((a) => a.outcome)).toEqual(['skipped']);
    const after = T0 + 70 * MIN; // 11:10 UTC
    await dispatchMinute(t.env, after);
    await t.drainJobs();
    expect((await alertsOf(ctx)).map((a) => `${a.kind}:${a.outcome}`)).toContain('down:sent');
  });

  it('repeats a reminder every X minutes while down', async () => {
    const { t, ctx } = await setup({ repeatMin: 30 });
    fakeSite({ status: 500 });
    await dispatchMinute(t.env, T0 + MIN);
    await t.drainJobs();
    for (let i = 2; i <= 70; i++) {
      await dispatchMinute(t.env, T0 + i * MIN);
      await t.drainJobs();
    }
    const kinds = (await alertsOf(ctx)).filter((a) => a.outcome === 'sent').map((a) => a.kind);
    expect(kinds[0]).toBe('down');
    expect(kinds.filter((k) => k === 'repeat').length).toBe(2);
  });

  it('rejects a webhook that points at a private address and a Slack URL on the wrong host', async () => {
    const t = createTestEnv();
    const ctx = await ctxOf(t);
    await expect(createChannel(ctx, { name: 'x', kind: 'webhook', config: { url: 'https://10.0.0.1/x' } })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createChannel(ctx, { name: 'x', kind: 'slack', config: { url: 'https://evil.example.com/x' } })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(createChannel(ctx, { name: 'x', kind: 'email', config: { to: 'not-an-address' } })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
