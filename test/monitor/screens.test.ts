import { describe, expect, it, vi } from 'vitest';
import monitor from '../../src/modules/monitor/module';
import { listChannels } from '../../src/modules/monitor/channels';
import { createMonitor, listMonitors } from '../../src/modules/monitor/monitors';
import { recordPing } from '../../src/modules/monitor/heartbeats';
import { createPage } from '../../src/modules/monitor/pages';
import { moduleContext } from '../../src/core/registry';
import { mountModule } from '../helpers/app';
import { createTestEnv } from '../helpers/d1';
import { T0, ctxOf, fakeSite, useModule } from './helpers';

useModule();

const html = async (res: Response) => res.text();

describe('monitor screens', () => {
  it('shows the first run when nothing is set up, and links its assets', async () => {
    const app = await mountModule(createTestEnv(), monitor);
    const res = await app.request('/app/monitor');
    expect(res.status).toBe(200);
    const body = await html(res);
    expect(body).toContain('Start with one address');
    expect(body).toContain('/m/monitor/monitor.css');
    expect(body).not.toMatch(/ style="/);
  });

  it('adds a monitor from a pasted address, checks it and lands on its page', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const res = await app.request('/app/monitor/quick', { form: { url: 'example.com' } });
    expect(res.status).toBe(302);
    const to = res.headers.get('location') ?? '';
    expect(to).toMatch(/\/app\/monitor\/m\/[^/]+\?first=1$/);
    const page = await app.request(to);
    expect(page.status).toBe(200);
    const body = await html(page);
    expect(body).toContain('example.com');
    expect(body).toContain('You’re set up');
    expect(await listMonitors(await ctxOf(t))).toHaveLength(1);
    const list = await html(await app.request('/app/monitor'));
    expect(list).toContain('example.com');
  });

  it('shows a mistake next to the field and keeps what was typed', async () => {
    const app = await mountModule(createTestEnv(), monitor);
    const res = await app.request('/app/monitor/quick', { form: { url: 'http://localhost:8080/' } });
    expect(res.status).toBe(422);
    expect(await html(res)).toContain('can’t be checked');
    const bad = await app.request('/app/monitor/new', { form: { type: 'http', name: 'x', url: '', intervalMin: '5' } });
    expect(bad.status).toBe(422);
    expect(await html(bad)).toContain('role="alert"');
  });

  it('creates a heartbeat monitor and shows its ping address', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const res = await app.request('/app/monitor/new', { form: { type: 'heartbeat', name: 'Nightly backup', hbPeriodSec: '86400', hbGraceMin: '30', failAfter: '1', channelMode: 'all' } });
    expect(res.status).toBe(302);
    const body = await html(await app.request(res.headers.get('location') ?? ''));
    expect(body).toContain('/hb/');
    expect(body).toContain('curl');
  });

  it('stops polling for a heartbeat once its first ping is in, and keeps showing the first steps', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const res = await app.request('/app/monitor/new', { form: { type: 'heartbeat', name: 'Nightly backup', hbPeriodSec: '86400', hbGraceMin: '30', failAfter: '1', channelMode: 'all' } });
    const to = res.headers.get('location') ?? '';
    const before = await html(await app.request(to));
    expect(before).toContain('data-poll');
    const token = before.match(/\/hb\/([A-Za-z0-9_-]{16,64})/)?.[1] ?? '';
    expect(await recordPing(t.env, token, 'success')).toBe('ok');
    const after = await html(await app.request(to.replace('?first=1', '')));
    expect(after).not.toContain('data-poll');
    expect(after).toContain('First ping received');
  });

  it('lets a viewer read but not change anything', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    await createMonitor(await ctxOf(t), { name: 'Home', url: 'https://example.com/' });
    const viewer = app.as({ role: 'viewer' });
    expect((await viewer.request('/app/monitor')).status).toBe(200);
    expect((await viewer.request('/app/monitor/quick', { form: { url: 'example.com' } })).status).toBe(403);
    expect((await viewer.request('/app/monitor/settings', { form: { retentionDays: '30' } })).status).toBe(403);
  });

  it('opens an incident, posts an update and resolves it', async () => {
    const app = await mountModule(createTestEnv(), monitor);
    expect(await html(await app.request('/app/monitor/incidents'))).toContain('No open incidents');
    const made = await app.request('/app/monitor/incidents/new', { form: { title: 'Slow logins', status: 'investigating', impact: 'minor', body: 'We are looking into it.' } });
    expect(made.status).toBe(302);
    const to = made.headers.get('location') ?? '';
    expect(await html(await app.request(to))).toContain('We are looking into it.');
    const upd = await app.request(`${to}/update`, { form: { status: 'resolved', body: 'Fixed.' } });
    expect(upd.status).toBe(302);
    expect(await html(await app.request(to))).toContain('Fixed.');
    const empty = await app.request('/app/monitor/incidents/new', { form: { title: '', status: 'investigating', impact: 'minor', body: '' } });
    expect(empty.status).toBe(422);
  });

  it('adds channels, tests one and refuses a private webhook address', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    expect(await html(await app.request('/app/monitor/alerts'))).toContain('No alert channels yet');
    const hook = await app.request('/app/monitor/alerts/new?kind=webhook', { form: { kind: 'webhook', name: 'Ops hook', url: 'https://example.com/hook' } });
    expect(hook.status).toBe(302);
    const bad = await app.request('/app/monitor/alerts/new?kind=webhook', { form: { kind: 'webhook', name: 'Local', url: 'http://localhost/hook' } });
    expect(bad.status).toBe(422);
    const [channel] = await listChannels(await ctxOf(t));
    const test = await app.request(`/app/monitor/alerts/${channel!.id}/test`, { method: 'POST' });
    expect(test.status).toBe(302);
  });

  it('creates a maintenance window and a status page with a component', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const m = await createMonitor(await ctxOf(t), { name: 'Home', url: 'https://example.com/' });
    const win = await app.request('/app/monitor/maintenance/new', { form: { title: 'Database upgrade', startsAt: '2030-01-10T01:00', durationMin: '60', scope: 'all' } });
    expect(win.status).toBe(302);
    expect(await html(await app.request('/app/monitor/maintenance'))).toContain('Database upgrade');
    const page = await app.request('/app/monitor/pages/new', { form: { title: 'Acme status', slug: 'acme' } });
    expect(page.status).toBe(302);
    const to = page.headers.get('location') ?? '';
    const add = await app.request(`${to}/components`, { form: { name: 'Website', monitorId: m.id } });
    expect(add.status).toBe(302);
    const screen = await html(await app.request(to));
    expect(screen).toContain('Website');
    const share = await html(await app.request(`${to}?tab=share`));
    expect(share).toContain('/status/acme/badge.svg');
    expect(share).toContain('widget.js');
    const pub = await app.as({ kind: 'anon' }).request('/status/acme');
    expect(pub.status).toBe(200);
    expect(await html(pub)).toContain('Website');
  });

  it('imports a UptimeRobot export and reports what it did', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const csv = 'Friendly Name,URL,Type,Interval\nSite,https://example.com/a,HTTP(s),5\nBad,http://localhost/x,HTTP(s),5\n';
    const form = new FormData();
    form.set('file', new File([csv], 'monitors.csv', { type: 'text/csv' }));
    const res = await app.request('/app/monitor/settings/import', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    const body = await html(res);
    expect(body).toContain('1 imported');
    expect((await listMonitors(await ctxOf(t))).map((x) => x.name)).toContain('Site');
  });

  it('keeps one workspace out of another', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const other = await moduleContext(t.env, { id: 'org_other', name: 'Other', slug: 'other' });
    const p = await createPage(other, { title: 'Theirs', slug: 'theirs', published: true });
    expect((await app.request(`/app/monitor/pages/${p.id}`)).status).toBe(404);
  });

  it('drops the cached status page when an incident changes, so visitors see it at once', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const ctx = await ctxOf(t);
    await createPage(ctx, { title: 'Shed status', slug: 'shed-status', published: true });
    const dropped: string[] = [];
    vi.stubGlobal('caches', { default: { delete: async (req: Request) => (dropped.push(new URL(req.url).pathname), true) } });
    const res = await app.request('/app/monitor/incidents/new', { form: { title: 'Down', message: 'Looking', status: 'investigating', impact: 'major' } });
    expect(res.status).toBe(302);
    expect(dropped).toContain('/status/shed-status');
  });

  it('says how often a monitor is checked in the first steps, not a fixed minute', async () => {
    fakeSite();
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    const m = await createMonitor(await ctxOf(t), { name: 'Slow', url: 'https://example.com/', intervalMin: 10 }, { at: T0 });
    const body = await html(await app.request(`/app/monitor/m/${m.id}?first=1`));
    expect(body).toContain('every 10 minutes');
  });
});
