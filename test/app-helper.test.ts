import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { requireScope } from '../src/core/guards';
import { defineModule } from '../src/core/module';
import type { AppEnv } from '../src/env';
import { mountModule } from './helpers/app';
import { createTestEnv } from './helpers/d1';

function sample() {
  const api = new Hono<AppEnv>();
  api.get('/', requireScope('sample:read'), (c) => c.json({ org: c.get('org')?.id, kind: c.get('auth').kind }));
  api.post('/', requireScope('sample:write'), async (c) => {
    const body = await c.req.json<{ name: string }>();
    c.executionCtx.waitUntil(c.env.KV.put('sample:last', body.name));
    return c.json({ name: body.name }, 201);
  });

  const dashboard = new Hono<AppEnv>();
  dashboard.get('/', (c) => c.text(`Hello ${c.get('user')?.name}`));
  dashboard.post('/', async (c) => c.text(`Saved ${(await c.req.parseBody()).name}`));

  const pub = new Hono<AppEnv>();
  pub.get('/sample/:slug', (c) => c.text(`public ${c.req.param('slug')}`));

  return defineModule({
    id: 'sample',
    name: 'Sample',
    description: 'A module used by the helper tests',
    icon: 'box',
    category: 'product',
    version: '0.0.0',
    permissions: [
      { scope: 'sample:read', label: 'Read' },
      { scope: 'sample:write', label: 'Write' },
    ],
    api,
    dashboard,
    public: pub,
    publicPrefixes: ['/sample'],
    fallback: async (c) => (new URL(c.req.url).pathname === '/abc' ? c.text('short link') : null),
  });
}

describe('mountModule', () => {
  it('calls the API as a signed-in admin by default', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, sample());
    const res = await app.request('/api/v1/sample');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ org: t.org.id, kind: 'session' });
    expect((await app.request('/api/v1/sample', { json: { name: 'A' } })).status).toBe(201);
    expect(await t.env.KV.get('sample:last')).toBe('A');
  });

  it('applies roles and scopes', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, sample());
    expect((await app.as({ role: 'viewer' }).request('/api/v1/sample', { json: { name: 'A' } })).status).toBe(403);
    const key = app.as({ kind: 'apikey', scopes: ['sample:read'] });
    expect((await key.request('/api/v1/sample')).status).toBe(200);
    expect((await key.request('/api/v1/sample', { json: { name: 'A' } })).status).toBe(403);
  });

  it('keeps strangers out of the dashboard and API but lets them see public pages', async () => {
    const t = createTestEnv();
    const visitor = (await mountModule(t, sample())).as({ kind: 'anon' });
    expect((await visitor.request('/api/v1/sample')).status).toBe(401);
    const page = await visitor.request('/app/sample');
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toContain('/sign-in');
    expect(await (await visitor.request('/sample/hello')).text()).toBe('public hello');
    expect(await (await visitor.request('/abc')).text()).toBe('short link');
    expect((await visitor.request('/nope')).status).toBe(404);
  });

  it('posts dashboard forms and blocks posts from another site', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, sample());
    expect(await (await app.request('/app/sample')).text()).toBe('Hello Test Person');
    expect(await (await app.request('/app/sample', { form: { name: 'Docs' } })).text()).toBe('Saved Docs');
    const crossSite = await app.request('/app/sample', { form: { name: 'x' }, headers: { origin: 'https://evil.example' } });
    expect(crossSite.status).toBe(403);
  });

  it('answers module_off when the module is turned off', async () => {
    const t = createTestEnv();
    const app = await mountModule(t, sample(), { off: true });
    const res = await app.request('/api/v1/sample');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('module_off');
  });
});
