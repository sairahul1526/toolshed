import { describe, expect, it } from 'vitest';
import monitor from '../../src/modules/monitor/module';
import { createMonitor } from '../../src/modules/monitor/monitors';
import { moduleContext } from '../../src/core/registry';
import { mountModule } from '../helpers/app';
import { createTestEnv } from '../helpers/d1';
import { fakeSite, useModule } from './helpers';

useModule();

describe('monitor API', () => {
  it('creates, reads, updates and deletes a monitor', async () => {
    fakeSite();
    const app = await mountModule(createTestEnv(), monitor);
    const made = await app.request('/api/v1/monitor/monitors', { json: { name: 'Home', url: 'https://example.com/' } });
    expect(made.status).toBe(201);
    const { id } = (await made.json()) as { id: string };
    expect(((await (await app.request(`/api/v1/monitor/monitors/${id}`)).json()) as { name: string }).name).toBe('Home');
    const patched = await app.request(`/api/v1/monitor/monitors/${id}`, { method: 'PATCH', json: { name: 'Homepage' } });
    expect(((await patched.json()) as { name: string }).name).toBe('Homepage');
    expect((await app.request(`/api/v1/monitor/monitors/${id}`, { method: 'DELETE' })).status).toBeLessThan(300);
    expect((await app.request(`/api/v1/monitor/monitors/${id}`)).status).toBe(404);
  });

  it('turns bad input into a clear error and refuses private addresses', async () => {
    const app = await mountModule(createTestEnv(), monitor);
    expect((await app.request('/api/v1/monitor/monitors', { json: { name: '', url: 'nope' } })).status).toBe(422);
    const res = await app.request('/api/v1/monitor/monitors', { json: { name: 'Local', url: 'http://localhost:8080/' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('monitor.url_not_allowed');
  });

  it('lets a read-only key read but not write, and keeps workspaces apart', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, monitor);
    await app.request('/api/v1/monitor/monitors', { json: { name: 'Mine', url: 'https://example.com/' } });
    const other = await moduleContext(t.env, { id: 'org_other', name: 'Other', slug: 'other' });
    await createMonitor(other, { name: 'Theirs', url: 'https://example.com/x' });

    const reader = app.as({ kind: 'apikey', scopes: ['monitor:read'] });
    const list = (await (await reader.request('/api/v1/monitor/monitors')).json()) as { items: { name: string }[] };
    expect(list.items.map((m) => m.name)).toEqual(['Mine']);
    expect((await reader.request('/api/v1/monitor/monitors', { json: { name: 'X', url: 'https://example.com/' } })).status).toBe(403);
    expect((await app.as({ kind: 'apikey', scopes: ['links:read'] }).request('/api/v1/monitor/monitors')).status).toBe(403);
    expect((await app.as({ kind: 'anon' }).request('/api/v1/monitor/monitors')).status).toBeGreaterThanOrEqual(401);
  });

  it('is unreachable when the module is turned off', async () => {
    const app = await mountModule(createTestEnv(), monitor, { off: true });
    expect((await app.request('/api/v1/monitor/monitors')).status).toBe(404);
  });

  it('imports a CSV and exports it back', async () => {
    const app = await mountModule(createTestEnv(), monitor);
    const res = await app.request('/api/v1/monitor/import', { json: { csv: 'name,url\nHome,https://example.com/' } });
    expect(res.status).toBe(201);
    const csv = await (await app.request('/api/v1/monitor/export/monitors.csv')).text();
    expect(csv).toContain('https://example.com/');
  });
});

describe('public routes', () => {
  async function withPage() {
    fakeSite();
    const t = createTestEnv({ ENVIRONMENT: 'dev' });
    const app = await mountModule(t, monitor);
    const m = (await (await app.request('/api/v1/monitor/monitors', { json: { name: 'Web', url: 'https://example.com/' } })).json()) as { id: string };
    const p = (await (await app.request('/api/v1/monitor/pages', { json: { title: 'Acme', slug: 'acme', published: true } })).json()) as { id: string };
    await app.request(`/api/v1/monitor/pages/${p.id}/components`, { json: { name: 'Website', monitorId: m.id } });
    return { t, app, visitor: app.as({ kind: 'anon' }), p };
  }

  it('serves the status page, JSON, feeds and badge to anyone', async () => {
    const { visitor } = await withPage();
    const html = await visitor.request('/status/acme');
    expect(html.status).toBe(200);
    expect(await html.text()).toContain('Acme');
    const json = await visitor.request('/status/acme/status.json');
    expect(json.headers.get('access-control-allow-origin')).toBe('*');
    expect(((await json.json()) as { components: unknown[] }).components).toHaveLength(1);
    expect((await visitor.request('/status/acme/feed.rss')).headers.get('content-type')).toContain('xml');
    expect((await visitor.request('/status/acme/feed.atom')).status).toBe(200);
    expect((await (await visitor.request('/status/acme/badge.svg')).text()).startsWith('<svg')).toBe(true);
    expect((await visitor.request('/status/missing')).status).toBe(404);
  });

  it('does not show an unpublished page', async () => {
    const { app, visitor, p } = await withPage();
    await app.request(`/api/v1/monitor/pages/${p.id}`, { method: 'PATCH', json: { published: false } });
    expect((await visitor.request('/status/acme')).status).toBe(404);
  });

  it('takes a heartbeat by token and answers 404 for a wrong one', async () => {
    const { app, visitor } = await withPage();
    const hb = (await (await app.request('/api/v1/monitor/monitors', { json: { name: 'Nightly', type: 'heartbeat', hbPeriodSec: 3600, hbGraceSec: 300 } })).json()) as { heartbeat: { pingUrl: string } };
    const path = new URL(hb.heartbeat.pingUrl).pathname;
    const ok = await visitor.request(path);
    expect(ok.status).toBe(200);
    expect((await visitor.request(`${path}/fail`, { method: 'POST', body: 'disk full' })).status).toBe(200);
    expect((await visitor.request('/hb/not-a-real-token')).status).toBe(404);
  });

  it('accepts a subscription without revealing whether the address is known', async () => {
    const { visitor } = await withPage();
    const send = () => visitor.request('/status/acme/subscribe', { form: { email: 'a@example.com', website: '' } });
    const first = await send();
    const second = await send();
    expect(first.status).toBe(second.status);
    expect((await visitor.request('/status/acme/subscribe', { form: { email: 'bot@example.com', website: 'http://spam' } })).status).toBeLessThan(400);
  });
});
