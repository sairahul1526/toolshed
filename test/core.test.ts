import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createApp } from '../src/app';
import { newId, orgDb } from '../src/core/db';
import { AppError, defineErrors, errors, listErrorCodes, parse } from '../src/core/errors';
import { emit, eventCounts, recentEvents } from '../src/core/events';
import { hasScope } from '../src/core/guards';
import { runSchedules } from '../src/core/jobs';
import { defineModule } from '../src/core/module';
import { enforceRateLimit, rateLimit } from '../src/core/ratelimit';
import { moduleState, purgeOrgData, registerModules, setModuleEnabled } from '../src/core/registry';
import { getSetting, setSetting } from '../src/core/settings';
import { sendEmail, devOutbox } from '../src/core/email';
import type { AppEnv } from '../src/env';
import { createTestEnv } from './helpers/d1';

afterEach(() => registerModules([]));

describe('newId', () => {
  it('is prefixed, lowercase and sorts by time', () => {
    const a = newId('lnk', 1_700_000_000_000);
    const b = newId('lnk', 1_700_000_000_001);
    expect(a).toMatch(/^lnk_[0-9a-z]{22}$/);
    expect(a < b).toBe(true);
    expect(newId('x')).not.toBe(newId('x'));
  });
});

describe('orgDb', () => {
  const setup = () => {
    const t = createTestEnv();
    t.sqlite.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT, pinned INTEGER, meta TEXT, created_at INTEGER)');
    return { t, a: orgDb(t.env.DB, 'org_a'), b: orgDb(t.env.DB, 'org_b') };
  };

  it('keeps each workspace to its own rows', async () => {
    const { a, b } = setup();
    const row = await a.insert<{ id: string; org_id: string }>('notes', { id: 'n1', title: 'Hello', pinned: true, meta: { k: 1 } });
    expect(row).toMatchObject({ id: 'n1', org_id: 'org_a', pinned: 1, meta: '{"k":1}' });
    expect(await b.get('notes', 'n1')).toBeNull();
    expect(await b.update('notes', 'n1', { title: 'Stolen' })).toBeNull();
    expect(await b.remove('notes', 'n1')).toBe(false);
    expect(await b.count('notes')).toBe(0);
    expect(await a.count('notes')).toBe(1);
    expect(await a.update('notes', 'n1', { title: 'New', org_id: 'org_b' })).toMatchObject({ title: 'New', org_id: 'org_a' });
    expect(await a.remove('notes', 'n1')).toBe(true);
  });

  it('lists with filters, order and limits', async () => {
    const { a } = setup();
    for (let i = 1; i <= 5; i++) await a.insert('notes', { id: `n${i}`, title: `T${i}`, pinned: i % 2, created_at: i });
    expect((await a.list<{ id: string }>('notes', { orderBy: 'created_at desc', limit: 2 })).map((r) => r.id)).toEqual(['n5', 'n4']);
    expect(await a.count('notes', { pinned: 1 })).toBe(3);
    expect(await a.findOne('notes', { title: 'T2' })).toMatchObject({ id: 'n2' });
    expect(await a.findOne('notes', { meta: null, title: 'T3' })).toMatchObject({ id: 'n3' });
  });

  it('requires :org in custom SQL and numbers the other parameters', async () => {
    const { a, b } = setup();
    await a.insert('notes', { id: 'n1', title: 'A', created_at: 5 });
    await b.insert('notes', { id: 'n2', title: 'B', created_at: 9 });
    expect(await a.all('SELECT id FROM notes WHERE org_id = :org AND created_at > ? AND title = ?', 1, 'A')).toEqual([{ id: 'n1' }]);
    expect(await a.first('SELECT COUNT(*) AS n FROM notes WHERE org_id = :org')).toEqual({ n: 1 });
    expect(await a.run('DELETE FROM notes WHERE org_id = :org')).toEqual({ changes: 1 });
    expect(await b.count('notes')).toBe(1);
    await expect(a.all('SELECT * FROM notes')).rejects.toThrow(/:org/);
  });

  it('refuses unsafe table, column and sort names', async () => {
    const { a } = setup();
    await expect(a.list('notes; DROP TABLE notes')).rejects.toThrow(/Unsafe/);
    await expect(a.insert('notes', { 'id) --': 1 })).rejects.toThrow(/Unsafe/);
    await expect(a.list('notes', { orderBy: 'id; DROP' })).rejects.toThrow(/Unsafe/);
  });
});

describe('errors', () => {
  it('has stable codes and plain messages', () => {
    const err = errors.not_found();
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({ code: 'not_found', status: 404 });
    expect(errors.conflict('That name is taken.').message).toBe('That name is taken.');
    expect(listErrorCodes().map((e) => e.code)).toContain('rate_limited');
  });

  it('prefixes module codes and refuses duplicates', () => {
    const e = defineErrors('testmod', { slug_taken: { status: 409, message: 'That short name is taken. Try another.' } });
    expect(e.slug_taken()).toMatchObject({ code: 'testmod.slug_taken', status: 409 });
    expect(() => defineErrors('testmod', { slug_taken: { status: 409, message: 'x' } })).toThrow(/twice/);
  });

  it('turns schema failures into one message per field', () => {
    const schema = z.object({ url: z.url('Enter a full web address, like https://example.com.'), name: z.string().min(1, 'Add a name.') });
    try {
      parse(schema, { url: 'nope', name: '' });
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({ code: 'validation_failed', status: 422, fields: { url: 'Enter a full web address, like https://example.com.', name: 'Add a name.' } });
    }
  });
});

describe('core services', () => {
  it('stores settings per scope', async () => {
    const { env } = createTestEnv();
    expect(await getSetting(env, 'instance', 'k', 'fallback')).toBe('fallback');
    await setSetting(env, 'instance', 'k', { a: 1 });
    await setSetting(env, 'org_a', 'k', { a: 2 });
    await setSetting(env, 'instance', 'k', { a: 3 });
    expect(await getSetting(env, 'instance', 'k', null)).toEqual({ a: 3 });
    expect(await getSetting(env, 'org_a', 'k', null)).toEqual({ a: 2 });
  });

  it('rate limits per key and window', async () => {
    const { env } = createTestEnv();
    const rule = { limit: 2, windowSec: 60 };
    const now = 1_700_000_000_000;
    expect((await rateLimit(env, 'k', rule, now)).ok).toBe(true);
    expect(await rateLimit(env, 'k', rule, now)).toMatchObject({ ok: true, remaining: 0 });
    expect((await rateLimit(env, 'k', rule, now)).ok).toBe(false);
    expect((await rateLimit(env, 'other', rule, now)).ok).toBe(true);
    expect((await rateLimit(env, 'k', rule, now + 61_000)).ok).toBe(true);
    await enforceRateLimit(env, 'e', { limit: 1, windowSec: 60 });
    await expect(enforceRateLimit(env, 'e', { limit: 1, windowSec: 60 })).rejects.toMatchObject({ code: 'rate_limited', status: 429 });
  });

  it('logs dev email with its body', async () => {
    const { env } = createTestEnv({ ENVIRONMENT: 'dev' });
    const res = await sendEmail(env, { to: 'sam@example.com', subject: 'Your code', html: '<b>123456</b>', text: '123456', template: 'sign-in-code' });
    expect(res.status).toBe('dev');
    expect(await devOutbox(env, { to: 'sam@example.com' })).toMatchObject([{ subject: 'Your code', text: '123456', template: 'sign-in-code' }]);
    expect(await devOutbox(env, { to: 'nobody@example.com' })).toEqual([]);
  });

  it('marks email as not configured in production without a sender', async () => {
    const { env } = createTestEnv({ ENVIRONMENT: 'production' });
    const res = await sendEmail(env, { to: 'sam@example.com', subject: 'Hi', html: 'x', text: 'secret body' });
    expect(res.status).toBe('not_configured');
    expect((await devOutbox(env))[0]).toMatchObject({ text: null, html: null });
  });
});

describe('modules, events and jobs', () => {
  const seen: string[] = [];
  const ran: string[] = [];
  const emitter = () =>
    defineModule({
      id: 'emitter', name: 'Emitter', description: 'Emits', icon: 'link', category: 'growth', version: '0.1.0',
      tables: ['emitter_rows'],
      schedules: [
        { name: 'tick', every: 'minute', run: async () => void ran.push('tick') },
        { name: 'nightly', every: 'day', run: async () => void ran.push('nightly') },
        { name: 'broken', every: 'minute', run: async () => { throw new Error('boom'); } },
      ],
    });
  const listener = () =>
    defineModule({
      id: 'listener', name: 'Listener', description: 'Listens', icon: 'bell', category: 'growth', version: '0.1.0',
      events: { on: { 'emitter.thing.made': async (ctx, e) => void seen.push(`${ctx.org.id}:${e.subject}`) } },
    });

  it('counts events per day and delivers them to subscribed, enabled modules', async () => {
    seen.length = 0;
    const t = createTestEnv();
    registerModules([emitter(), listener()]);
    const now = Date.UTC(2026, 10, 21, 12);
    await emit(t.env, { orgId: 'org_a', module: 'emitter', name: 'thing.made', subject: 's1', at: now });
    expect(await t.drainJobs()).toBe(1);
    expect(seen).toEqual([]); // listener is off for org_a

    await setModuleEnabled(t.env, 'org_a', 'listener', true);
    await emit(t.env, { orgId: 'org_a', module: 'emitter', name: 'thing.made', subject: 's2', count: 3, at: now + 1000 });
    await emit(t.env, { orgId: 'org_a', module: 'emitter', name: 'thing.made', subject: 's3', at: now - 86_400_000 });
    await t.drainJobs();
    expect(seen).toEqual(['org_a:s2', 'org_a:s3']);

    const counts = await eventCounts(t.env, 'org_a', { module: 'emitter', name: 'thing.made', days: 3, now });
    expect(counts).toEqual([
      { day: '2026-11-19', count: 0 },
      { day: '2026-11-20', count: 1 },
      { day: '2026-11-21', count: 4 },
    ]);
    expect((await recentEvents(t.env, 'org_a', { limit: 2 })).map((e) => e.subject)).toEqual(['s2', 's1']);
    expect(await eventCounts(t.env, 'org_b', { module: 'emitter', days: 1, now })).toEqual([{ day: '2026-11-21', count: 0 }]);
  });

  it('runs due schedules and survives a failing one', async () => {
    ran.length = 0;
    const t = createTestEnv();
    registerModules([emitter()]);
    const res = await runSchedules(t.env, new Date(Date.UTC(2026, 10, 21, 9, 7)));
    expect(ran).toEqual(['tick']);
    expect(res.failed).toEqual(['emitter.broken']);
    await runSchedules(t.env, new Date(Date.UTC(2026, 10, 22, 0, 0)));
    expect(ran).toEqual(['tick', 'tick', 'nightly']);
  });

  it('turns modules on and off per workspace and purges a workspace', async () => {
    const t = createTestEnv();
    t.sqlite.exec('CREATE TABLE emitter_rows (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)');
    registerModules([emitter()]);
    expect((await moduleState(t.env, 'org_a', 'emitter')).enabled).toBe(false);
    await setModuleEnabled(t.env, 'org_a', 'emitter', true);
    expect((await moduleState(t.env, 'org_a', 'emitter')).enabled).toBe(true);
    expect((await moduleState(t.env, 'org_b', 'emitter')).enabled).toBe(false);
    await expect(setModuleEnabled(t.env, 'org_a', 'nope', true)).rejects.toMatchObject({ code: 'not_found' });

    await orgDb(t.env.DB, 'org_a').insert('emitter_rows', { id: 'r1' });
    await orgDb(t.env.DB, 'org_b').insert('emitter_rows', { id: 'r2' });
    await purgeOrgData(t.env, 'org_a');
    expect(await orgDb(t.env.DB, 'org_a').count('emitter_rows')).toBe(0);
    expect(await orgDb(t.env.DB, 'org_b').count('emitter_rows')).toBe(1);
    expect((await moduleState(t.env, 'org_a', 'emitter')).enabled).toBe(false);
  });

  it('refuses clashing modules and public routes outside the declared prefixes', () => {
    expect(() => registerModules([emitter(), emitter()])).toThrow(/share the id/);
    expect(() => defineModule({ ...emitter(), id: 'members' })).toThrow(/reserved/);
    const stray = new Hono<AppEnv>().get('/elsewhere', (c) => c.text('x'));
    expect(() => registerModules([defineModule({ ...emitter(), public: stray, publicPrefixes: ['/e'] })])).toThrow(/outside its publicPrefixes/);
  });
});

describe('app routing', () => {
  const build = () => {
    const pub = new Hono<AppEnv>().get('/p/:slug', (c) => c.text(`public ${c.req.param('slug')}`));
    const mod = defineModule({
      id: 'pages', name: 'Pages', description: 'Public pages', icon: 'file', category: 'content', version: '0.1.0',
      public: pub, publicPrefixes: ['/p'],
      dashboard: new Hono<AppEnv>().get('/', (c) => c.text('pages dashboard')),
      api: new Hono<AppEnv>().get('/items', (c) => c.json({ items: [] })),
      fallback: async (c) => (new URL(c.req.url).pathname === '/short' ? c.redirect('https://example.com/', 302) : null),
    });
    registerModules([mod]);
    return { app: createApp({ screens: {} }), t: createTestEnv() };
  };

  it('serves health, public routes and fallbacks without a session', async () => {
    const { app, t } = build();
    expect(await (await app.request('/healthz', {}, t.env)).json()).toEqual({ ok: true });
    expect(await (await app.request('/p/hello', {}, t.env)).text()).toBe('public hello');
    const short = await app.request('/short', {}, t.env);
    expect(short.status).toBe(302);
    expect(short.headers.get('location')).toBe('https://example.com/');
  });

  it('answers unknown paths with a 404 page or a JSON error', async () => {
    const { app, t } = build();
    const page = await app.request('/nope', { headers: { accept: 'text/html' } }, t.env);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('Page not found');
    const api = await app.request('/api/v1/nope', {}, t.env);
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ code: 'unauthorized' });
    expect(api.headers.get('x-request-id')).toBeTruthy();
  });

  it('sends signed-out browsers to sign-in and refuses signed-out API calls', async () => {
    const { app, t } = build();
    const dash = await app.request('/app/pages?tab=1', {}, t.env);
    expect(dash.status).toBe(302);
    expect(dash.headers.get('location')).toBe('/sign-in?next=%2Fapp%2Fpages%3Ftab%3D1');
    const api = await app.request('/api/v1/pages/items', {}, t.env);
    expect(api.status).toBe(401);
    const post = await app.request('/app/pages', { method: 'POST' }, t.env);
    expect(post.status).toBe(401);
  });

  it('hides dev routes in production', async () => {
    const { app } = build();
    const prod = createTestEnv({ ENVIRONMENT: 'production' });
    expect((await app.request('/dev/outbox', {}, prod.env)).status).toBe(404);
    const dev = createTestEnv({ ENVIRONMENT: 'dev' });
    expect(await (await app.request('/dev/outbox', {}, dev.env)).json()).toEqual({ emails: [] });
  });
});

describe('scopes', () => {
  it('lets write cover read and * cover everything', () => {
    expect(hasScope(['*'], 'links:write')).toBe(true);
    expect(hasScope(['links:write'], 'links:read')).toBe(true);
    expect(hasScope(['links:read'], 'links:write')).toBe(false);
    expect(hasScope(['links:*'], 'links:delete')).toBe(true);
    expect(hasScope(['forms:write'], 'links:read')).toBe(false);
  });
});
