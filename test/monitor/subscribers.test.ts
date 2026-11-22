import { describe, expect, it } from 'vitest';
import { devOutbox } from '../../src/core/email';
import { openIncident } from '../../src/modules/monitor/incidents';
import { createComponent, createPage } from '../../src/modules/monitor/pages';
import { confirmSubscriber, subscribe, unsubscribeByToken } from '../../src/modules/monitor/subscribers';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, T0, useModule } from './helpers';

useModule();

async function setup(vars: Record<string, string> = { ENVIRONMENT: 'dev' }) {
  const t = createTestEnv(vars);
  const ctx = await ctxOf(t);
  const page = await createPage(ctx, { title: 'Acme', slug: 'acme' }, { at: T0 });
  const comp = await createComponent(ctx, page.id, { name: 'Web' });
  return { t, ctx, page, comp };
}

const tokenIn = async (t: Awaited<ReturnType<typeof setup>>['t'], to: string) => {
  const mails = await devOutbox(t.env, { to });
  const link = /\/confirm\/([A-Za-z0-9_-]+)/.exec(mails[0]?.text ?? '');
  return link?.[1] ?? null;
};

describe('subscribers', () => {
  it('needs a click on the emailed link before anyone is subscribed', async () => {
    const { t, ctx, page } = await setup();
    await subscribe(t.env, page, { email: 'Fan@Example.com' }, 'http://localhost', T0);
    expect((await ctx.db.all<{ status: string }>('SELECT status FROM mon_subscribers WHERE org_id = :org'))[0]!.status).toBe('pending');
    const token = await tokenIn(t, 'fan@example.com');
    expect(token).toBeTruthy();
    expect((await confirmSubscriber(t.env, token!, T0 + 1000))?.page.slug).toBe('acme');
    expect((await ctx.db.all<{ status: string }>('SELECT status FROM mon_subscribers WHERE org_id = :org'))[0]!.status).toBe('confirmed');
  });

  it('answers the same for an address that is already subscribed and never sends it a second link', async () => {
    const { t, page } = await setup();
    await subscribe(t.env, page, { email: 'a@example.com' }, 'http://localhost', T0);
    await confirmSubscriber(t.env, (await tokenIn(t, 'a@example.com'))!, T0);
    const before = (await devOutbox(t.env, { to: 'a@example.com' })).length;
    await expect(subscribe(t.env, page, { email: 'a@example.com' }, 'http://localhost', T0 + 1)).resolves.toBeUndefined();
    expect((await devOutbox(t.env, { to: 'a@example.com' })).length).toBe(before);
  });

  it('rejects a bad address and a page that does not take subscribers', async () => {
    const { t, page } = await setup();
    await expect(subscribe(t.env, page, { email: 'nope' }, 'http://localhost')).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(subscribe(t.env, { ...page, allow_subscribe: 0 }, { email: 'a@example.com' }, 'http://localhost')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('emails confirmed subscribers about an incident, with an unsubscribe link, and stops after unsubscribe', async () => {
    const { t, ctx, page, comp } = await setup();
    await subscribe(t.env, page, { email: 'a@example.com' }, 'http://localhost', T0);
    await subscribe(t.env, page, { email: 'pending@example.com' }, 'http://localhost', T0);
    await confirmSubscriber(t.env, (await tokenIn(t, 'a@example.com'))!, T0);
    await openIncident(ctx, { title: 'Checkout is slow', impact: 'minor', body: 'We are looking', componentIds: [comp.id] }, { at: T0 + 1000, author: 'You' });
    await t.drainJobs();
    const got = (await devOutbox(t.env, { to: 'a@example.com' })).filter((m) => /Checkout is slow/.test(m.subject + m.text));
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toMatch(/\/status\/acme\/unsubscribe\//);
    expect((await devOutbox(t.env, { to: 'pending@example.com' })).filter((m) => /Checkout is slow/.test(m.subject + m.text))).toHaveLength(0);
    const sub = await ctx.db.all<{ token: string }>(`SELECT token FROM mon_subscribers WHERE org_id = :org AND email = 'a@example.com'`);
    await unsubscribeByToken(t.env, sub[0]!.token);
    await openIncident(ctx, { title: 'Second one', impact: 'minor', body: 'x', componentIds: [comp.id] }, { at: T0 + 2000, author: 'You' });
    await t.drainJobs();
    expect((await devOutbox(t.env, { to: 'a@example.com' })).filter((m) => /Second one/.test(m.subject + m.text))).toHaveLength(0);
  });
});
