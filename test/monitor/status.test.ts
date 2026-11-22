import { describe, expect, it } from 'vitest';
import { atomFeed, badgeSvg, rssFeed, statusJson } from '../../src/modules/monitor/feeds';
import { openIncident, postUpdate } from '../../src/modules/monitor/incidents';
import { createMaintenance } from '../../src/modules/monitor/maintenance';
import { createMonitor } from '../../src/modules/monitor/monitors';
import { createComponent, createGroup, createPage, loadStatus, safeCss, updateComponent } from '../../src/modules/monitor/pages';
import { applyResults } from '../../src/modules/monitor/runner';
import { rollupDay, rollupHour } from '../../src/modules/monitor/uptime';
import { createTestEnv } from '../helpers/d1';
import { ctxOf, MIN, T0, useModule } from './helpers';

useModule();

async function setup() {
  const t = createTestEnv();
  const ctx = await ctxOf(t);
  const m = await createMonitor(ctx, { name: 'API', url: 'https://example.com/' }, { at: T0 });
  const page = await createPage(ctx, { title: 'Acme status', slug: 'acme' }, { at: T0 });
  const group = await createGroup(ctx, page.id, { name: 'Core' });
  const comp = await createComponent(ctx, page.id, { name: 'API', monitorId: m.id, groupId: group.id });
  return { t, ctx, m, page, comp };
}

describe('status page data', () => {
  it('is operational with no problems and unknown slugs are not found', async () => {
    const { t } = await setup();
    const data = await loadStatus(t.env, 'acme', T0 + MIN);
    expect(data?.overall.status).toBe('operational');
    expect(data?.groups[0]?.components[0]?.name).toBe('API');
    expect(await loadStatus(t.env, 'nope', T0)).toBeNull();
  });

  it('shows an open incident and the manual status, worst one wins', async () => {
    const { t, ctx, comp } = await setup();
    await openIncident(ctx, { title: 'Slow API', impact: 'minor', body: 'Looking into it', componentIds: [comp.id] }, { at: T0 + MIN, author: 'You' });
    let data = await loadStatus(t.env, 'acme', T0 + 2 * MIN);
    expect(data?.overall.status).toBe('degraded');
    expect(data?.active[0]?.updates[0]?.body).toBe('Looking into it');
    await updateComponent(ctx, comp.id, { manualStatus: 'major' });
    data = await loadStatus(t.env, 'acme', T0 + 2 * MIN);
    expect(data?.overall.status).toBe('major');
  });

  it('moves a resolved incident to history and keeps the timeline', async () => {
    const { t, ctx, comp } = await setup();
    const inc = await openIncident(ctx, { title: 'Outage', impact: 'major', body: 'Down', componentIds: [comp.id] }, { at: T0 + MIN, author: 'You' });
    await postUpdate(ctx, inc.id, { status: 'resolved', body: 'Fixed' }, { at: T0 + 10 * MIN, author: 'You' });
    const data = await loadStatus(t.env, 'acme', T0 + 11 * MIN);
    expect(data?.active).toHaveLength(0);
    expect(data?.past[0]?.updates.map((u) => u.status)).toEqual(['resolved', 'investigating']);
  });

  it('shows maintenance and marks the covered component as under maintenance', async () => {
    const { t, ctx, m } = await setup();
    await createMaintenance(ctx, { title: 'DB upgrade', startsAt: T0, durationMin: 60, monitorIds: [m.id] }, { at: T0 });
    const data = await loadStatus(t.env, 'acme', T0 + 5 * MIN);
    expect(data?.maintenance[0]?.active).toBe(true);
    expect(data?.groups[0]?.components[0]?.status).toBe('maintenance');
  });

  it('draws 90 daily bars from rolled-up history', async () => {
    const { t, ctx, m } = await setup();
    const hour = Math.floor(T0 / 3_600_000) * 3_600_000;
    await applyResults(t.env, t.org.id, [{ m, r: { ok: true, ms: 120, code: 200, error: null } }], hour, '0', [], hour);
    await applyResults(t.env, t.org.id, [{ m: { ...m, status: 'up' }, r: { ok: false, ms: 900, code: 500, error: 'HTTP 500' } }], hour + MIN, '0', [], hour + MIN);
    await rollupHour(t.env, hour);
    await rollupDay(t.env, new Date(hour).toISOString().slice(0, 10));
    const data = await loadStatus(t.env, 'acme', T0 + 2 * MIN);
    const bars = data!.groups[0]!.components[0]!.bars!;
    expect(bars).toHaveLength(90);
    expect(bars.at(-1)?.pct).toBe(50);
    expect(bars.at(-1)?.level).toBe('bad');
    expect(ctx).toBeTruthy();
  });

  it('builds feeds, status.json and a badge without leaking markup', async () => {
    const { t, ctx, comp } = await setup();
    await openIncident(ctx, { title: 'A <b>bad</b> & day', impact: 'minor', body: 'x', componentIds: [comp.id] }, { at: T0, author: 'You' });
    const data = (await loadStatus(t.env, 'acme', T0 + MIN))!;
    expect(rssFeed(data, 'https://s.example.com')).toContain('A &lt;b&gt;bad&lt;/b&gt; &amp; day');
    expect(atomFeed(data, 'https://s.example.com')).toContain('<feed');
    expect(statusJson(data, 'https://s.example.com').status.indicator).toBe('minor');
    expect(badgeSvg('status', 'all systems <operational>', 'operational')).not.toContain('<operational>');
  });

  it('strips dangerous things from custom CSS', () => {
    const css = safeCss('@import url(https://evil.example.com/x.css); body{background:url(https://evil.example.com/a.png)} </style><script>x</script> a{color:red}');
    expect(css).not.toContain('evil.example.com');
    expect(css).not.toContain('<');
    expect(css).toContain('color:red');
  });
});
