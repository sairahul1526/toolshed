import { afterEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../../src/app';
import screen from '../../src/dashboard/modules';
import { defineModule, type ModuleDef } from '../../src/core/module';
import { moduleState, registerModules } from '../../src/core/registry';
import type { AppEnv, Role } from '../../src/env';
import { countQueries, createTestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

afterEach(() => {
  registerModules([]);
  vi.restoreAllMocks();
});

const ORIGIN = 'http://localhost';

function fake(id: string, over: Partial<ModuleDef> = {}): ModuleDef {
  return defineModule({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    description: `The ${id} module`,
    icon: 'link',
    category: 'growth',
    version: '1.2.0',
    ...over,
  });
}

/** One workspace, a signed-in person with `role`, and the app built after the modules are registered. */
async function setup(mods: ModuleDef[], role: Role = 'admin') {
  registerModules(mods);
  const t = createTestEnv();
  const app = createApp({ screens: { modules: screen } });
  const { headers } = await createTestSession(t.env, { role });
  return { t, app, headers };
}

function get(app: Hono<AppEnv>, t: TestEnv, headers: Record<string, string>, path: string) {
  return app.request(path, { headers }, t.env);
}

function post(app: Hono<AppEnv>, t: TestEnv, headers: Record<string, string>, path: string, form: Record<string, string>) {
  return app.request(
    path,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form) },
    t.env,
  );
}

function flashOf(res: Response): { kind: string; message: string } | null {
  const line = res.headers.getSetCookie().find((l) => l.startsWith('ts_flash='));
  if (!line) return null;
  // The kit encodes the value, and the cookie writer encodes it once more.
  return JSON.parse(decodeURIComponent(decodeURIComponent(line.slice('ts_flash='.length).split(';')[0]!)));
}

function audits(t: TestEnv, orgId = t.org.id) {
  return t.sqlite.prepare('SELECT action, target_type, target_id, summary, actor_label FROM audit_log WHERE org_id = ? ORDER BY rowid').all(orgId) as {
    action: string;
    target_type: string;
    target_id: string;
    summary: string;
    actor_label: string;
  }[];
}

const enabledRows = (t: TestEnv, orgId = t.org.id) =>
  (t.sqlite.prepare('SELECT module_id, enabled FROM module_state WHERE org_id = ? ORDER BY module_id').all(orgId) as { module_id: string; enabled: number }[]).map(
    (r) => `${r.module_id}:${r.enabled}`,
  );

const TURN_OFF_NOTE = 'Your data is kept. Public pages for this module stop working until you turn it back on.';

describe('who can open it', () => {
  it('shows owners and admins the turn on buttons', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const { t, app, headers } = await setup([fake('links')], role);
      const res = await get(app, t, headers, '/app/modules');
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('action="/app/modules/links/toggle"');
      expect(html).toContain('Turn on');
      expect(html).not.toContain('Only workspace admins and owners can turn modules on or off');
    }
  });

  it('shows members and viewers everything read-only, with a note', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const { t, app, headers } = await setup([fake('links'), fake('forms')], role);
      const html = await (await get(app, t, headers, '/app/modules')).text();
      expect(html).toContain('Links');
      expect(html).toContain('Forms');
      expect(html).toContain('Only workspace admins and owners can turn modules on or off. Ask an admin if you need one.');
      expect(html).not.toContain('/toggle');
      expect(html).not.toContain('Turn on');
      const detail = await (await get(app, t, headers, '/app/modules/links')).text();
      expect(detail).toContain('Only workspace admins and owners');
      expect(detail).not.toContain('/toggle');
    }
  });

  it('sends a signed-out visitor to sign in', async () => {
    registerModules([fake('links')]);
    const t = createTestEnv();
    const app = createApp({ screens: { modules: screen } });
    const res = await app.request('/app/modules?filter=on', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/sign-in?next=${encodeURIComponent('/app/modules?filter=on')}`);
  });
});

describe('the sidebar', () => {
  it('marks only Modules as the current page, not the Add a module shortcut', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    const html = await (await get(app, t, headers, '/app/modules')).text();
    expect(html).toContain('Add a module');
    const links = [...html.matchAll(/<a href="\/app\/modules"([^>]*)>/g)].map((m) => m[1] ?? '');
    const add = links.find((attrs) => attrs.includes('title="Add a module"') && !attrs.includes('icon-btn'));
    const own = links.find((attrs) => attrs.includes('title="Modules"'));
    expect(add).toBeDefined();
    expect(add).not.toContain('aria-current');
    expect(own).toContain('aria-current="page"');
  });
});

describe('the grid', () => {
  it('shows each module with its name, one-line description, category and state', async () => {
    const mods = [
      fake('links', { name: 'Links', description: 'Short links on your own domain', category: 'growth' }),
      fake('forms', { name: 'Forms', description: 'Forms you can embed', category: 'support' }),
      fake('mail', {
        name: 'Email',
        description: 'Sends sign-in codes',
        category: 'messaging',
        setup: async () => ({ status: 'needs_setup', reason: 'Needs email sending set up.', action: { label: 'Set up email', href: '/app/email' } }),
      }),
    ];
    const { t, app, headers } = await setup(mods);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, enabled_at) VALUES (?, 'links', 1, 1)").run(t.org.id);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, enabled_at) VALUES (?, 'mail', 1, 1)").run(t.org.id);
    const html = await (await get(app, t, headers, '/app/modules')).text();
    expect(html).toContain('Short links on your own domain');
    expect(html).toContain('Growth');
    expect(html).toContain('Support');
    const card = (id: string) => html.split('<article class="card mod-card"').find((s) => s.includes(`data-id="${id}"`))!;
    expect(card('links')).toContain('pill good');
    expect(card('links')).toContain('>On<');
    expect(card('links')).toContain('Turn off');
    expect(card('forms')).toContain('pill neutral');
    expect(card('forms')).toContain('>Off<');
    expect(card('mail')).toContain('pill solid');
    expect(card('mail')).toContain('Needs setup');
    expect(card('mail')).toContain('Needs email sending set up.');
  });

  it('counts On and Off on the tabs from every module, not just the visible ones', async () => {
    const { t, app, headers } = await setup([fake('alpha'), fake('beta'), fake('gamma')]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'alpha', 1)").run(t.org.id);
    const html = await (await get(app, t, headers, '/app/modules?q=zzz')).text();
    expect(html).toMatch(/All<span class="n">3<\/span>/);
    expect(html).toMatch(/On<span class="n">1<\/span>/);
    expect(html).toMatch(/Off<span class="n">2<\/span>/);
  });

  it('survives a module whose setup check throws, and says it needs setup', async () => {
    const boom = fake('boom', {
      name: 'Boom',
      setup: async () => {
        throw new Error('secret internal detail');
      },
    });
    const { t, app, headers } = await setup([boom, fake('fine')]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'boom', 1)").run(t.org.id);
    const res = await get(app, t, headers, '/app/modules');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Needs setup');
    expect(html).toContain('We couldn’t check this module’s setup. Open it to see why.');
    expect(html).not.toContain('secret internal detail');
    expect(html).toContain('Fine');
    const detail = await get(app, t, headers, '/app/modules/boom');
    expect(detail.status).toBe(200);
    expect(await detail.text()).not.toContain('secret internal detail');
  });

  it('does not run the setup check of a module that is off', async () => {
    const setupFn = vi.fn(async () => ({ status: 'ready' as const }));
    const { t, app, headers } = await setup([fake('quiet', { setup: setupFn })]);
    await get(app, t, headers, '/app/modules');
    expect(setupFn).not.toHaveBeenCalled();
  });

  it('shows 30 modules in a handful of queries', async () => {
    const mods = Array.from({ length: 30 }, (_, i) => fake(`mod-${String(i).padStart(2, '0')}`, { name: `Module ${i}` }));
    const { t, app, headers } = await setup(mods);
    for (let i = 0; i < 30; i += 2) {
      t.sqlite.prepare('INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, ?, 1)').run(t.org.id, `mod-${String(i).padStart(2, '0')}`);
    }
    const { result: res, queries } = await countQueries(t.env, async () => get(app, t, headers, '/app/modules'));
    const html = await res.text();
    expect((html.match(/class="card mod-card"/g) ?? []).length).toBe(30);
    expect(html).toMatch(/On<span class="n">15<\/span>/);
    expect(queries.filter((q) => q.includes('module_state')).length).toBeLessThanOrEqual(3);
    expect(queries.length).toBeLessThanOrEqual(15);
  });

  it('keeps long names, long descriptions, non-Latin text and markup safe', async () => {
    const long = 'Supercalifragilistic'.repeat(15);
    const mods = [
      fake('long', { name: long, description: `${long} ${long}` }),
      fake('xss', { name: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>', category: 'files' }),
      fake('intl', { name: 'リンク短縮', description: 'Короткие ссылки для вашего сайта 🔗' }),
    ];
    const { t, app, headers } = await setup(mods);
    const html = await (await get(app, t, headers, '/app/modules')).text();
    expect(html).toContain(long);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('リンク短縮');
    expect(html).toContain('Короткие ссылки для вашего сайта');
    const detail = await (await get(app, t, headers, '/app/modules/xss')).text();
    expect(detail).not.toContain('<script>alert(1)</script>');
  });

  it('falls back to a generic icon when a module names one the kit does not have', async () => {
    const { t, app, headers } = await setup([fake('odd', { icon: 'no-such-icon' })]);
    expect(await (await get(app, t, headers, '/app/modules')).text()).toContain('#i-layers');
  });
});

describe('search and filters', () => {
  const mods = () => [
    fake('links', { name: 'Links', description: 'Short links and QR codes' }),
    fake('forms', { name: 'Forms', description: 'Embeddable forms' }),
    fake('monitor', { name: 'Monitor', description: 'Uptime checks', category: 'insights' }),
  ];

  async function names(app: Hono<AppEnv>, t: TestEnv, headers: Record<string, string>, path: string) {
    const html = await (await get(app, t, headers, path)).text();
    return [...html.matchAll(/data-id="([a-z-]+)"/g)].map((m) => m[1]);
  }

  it('searches name, description, id and category, ignoring case, all words must match', async () => {
    const { t, app, headers } = await setup(mods());
    expect(await names(app, t, headers, '/app/modules?q=LINKS')).toEqual(['forms', 'links', 'monitor'].filter((n) => n === 'links'));
    expect(await names(app, t, headers, '/app/modules?q=qr')).toEqual(['links']);
    expect(await names(app, t, headers, '/app/modules?q=insights')).toEqual(['monitor']);
    expect(await names(app, t, headers, '/app/modules?q=short+codes')).toEqual(['links']);
    expect(await names(app, t, headers, '/app/modules?q=short+uptime')).toEqual([]);
  });

  it('filters by On and Off and combines it with search', async () => {
    const { t, app, headers } = await setup(mods());
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'links', 1)").run(t.org.id);
    expect(await names(app, t, headers, '/app/modules?filter=on')).toEqual(['links']);
    expect(await names(app, t, headers, '/app/modules?filter=off')).toEqual(['forms', 'monitor']);
    expect(await names(app, t, headers, '/app/modules?filter=off&q=up')).toEqual(['monitor']);
    expect(await names(app, t, headers, '/app/modules?filter=on&q=forms')).toEqual([]);
  });

  it('ignores a filter or search it does not understand', async () => {
    const { t, app, headers } = await setup(mods());
    expect(await names(app, t, headers, '/app/modules?filter=banana')).toEqual(['forms', 'links', 'monitor']);
    const res = await get(app, t, headers, `/app/modules?q=${'x'.repeat(5000)}`);
    expect(res.status).toBe(200);
  });

  it('keeps the search in the tab links and the search box', async () => {
    const { t, app, headers } = await setup(mods());
    const html = await (await get(app, t, headers, '/app/modules?q=links&filter=off')).text();
    expect(html).toContain('href="/app/modules?q=links&amp;filter=on"');
    expect(html).toContain('href="/app/modules?q=links"');
    expect(html).toContain('value="links"');
    expect(html).toContain('name="filter" value="off"');
    expect(html).toContain('aria-current="page"');
  });

  it('shows a no results state that is different from the empty state, and escapes the search', async () => {
    const { t, app, headers } = await setup(mods());
    const html = await (await get(app, t, headers, `/app/modules?q=${encodeURIComponent('<b>zzz</b>')}`)).text();
    expect(html).toContain('No modules match');
    expect(html).toContain('&lt;b&gt;zzz&lt;/b&gt;');
    expect(html).not.toContain('<b>zzz</b>');
    expect(html).toContain('Clear search');
    expect(html).not.toContain('No modules are installed');
  });

  it('explains an empty On or Off filter', async () => {
    const { t, app, headers } = await setup(mods());
    expect(await (await get(app, t, headers, '/app/modules?filter=on')).text()).toContain('No modules are on yet');
    t.sqlite.exec(`INSERT INTO module_state (org_id, module_id, enabled) VALUES ('${t.org.id}', 'links', 1), ('${t.org.id}', 'forms', 1), ('${t.org.id}', 'monitor', 1)`);
    expect(await (await get(app, t, headers, '/app/modules?filter=off')).text()).toContain('Every module is on');
  });
});

describe('a build with no modules', () => {
  it('shows the empty state with one next step and no filters', async () => {
    const { t, app, headers } = await setup([]);
    const res = await get(app, t, headers, '/app/modules');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No modules are installed');
    expect(html).toContain('Back to overview');
    expect(html).not.toContain('role="search"');
    expect(html).not.toContain('mod-card');
  });

  it('still shows the empty state to a viewer', async () => {
    const { t, app, headers } = await setup([], 'viewer');
    expect(await (await get(app, t, headers, '/app/modules')).text()).toContain('No modules are installed');
  });
});

describe('the detail page', () => {
  const rich = () =>
    fake('links', {
      name: 'Links',
      description: 'Short links on your own domain',
      version: '2.0.1',
      publicPrefixes: ['/go', '/l'],
      permissions: [
        { scope: 'links:read', label: 'See links' },
        { scope: 'links:write', label: 'Create and change links' },
      ],
      onboarding: { title: 'Make your first link', body: 'Paste a long address and get a short one.' },
    });

  it('shows what the contract declares: state, version, public paths, API permissions, first step', async () => {
    const { t, app, headers } = await setup([rich()]);
    const html = await (await get(app, t, headers, '/app/modules/links')).text();
    expect(html).toContain('Short links on your own domain');
    expect(html).toContain('2.0.1');
    expect(html).toContain('/go');
    expect(html).toContain('/l<');
    expect(html).toContain('links:write');
    expect(html).toContain('Create and change links');
    expect(html).toContain('Make your first link');
    expect(html).toContain('Off. Nothing runs');
    expect(html).toContain('Not yet');
    expect(html).toContain('Turn on');
    expect(html).toContain('<title>Links');
  });

  it('shows a module with nothing declared without empty headings or errors', async () => {
    const { t, app, headers } = await setup([fake('plain')]);
    const html = await (await get(app, t, headers, '/app/modules/plain')).text();
    expect(html).toContain('This module has no API permissions of its own.');
    expect(html).not.toContain('Sample data');
    expect(html).not.toContain('Good first step');
    expect(html).not.toContain('docs/modules');
    expect(html).not.toContain('<h2>Settings');
  });

  it('shows the date it was turned on and a link to open it', async () => {
    const dash = fake('links', { dashboard: new Hono<AppEnv>() });
    const { t, app, headers } = await setup([dash]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, enabled_at) VALUES (?, 'links', 1, ?)").run(t.org.id, Date.UTC(2026, 10, 2));
    const html = await (await get(app, t, headers, '/app/modules/links')).text();
    expect(html).toContain('Nov 2, 2026');
    expect(html).toContain('href="/app/links"');
    expect(html).toContain('On and ready to use.');
    expect(html).toContain(TURN_OFF_NOTE);
  });

  it('shows the setup reason and button, and drops an unsafe link', async () => {
    const mk = (href: string) =>
      fake('mail', { setup: async () => ({ status: 'needs_setup', reason: 'Pick a sending domain first.', action: { label: 'Open email setup', href } }) });
    const a = await setup([mk('/app/email')]);
    a.t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'mail', 1)").run(a.t.org.id);
    const ok = await (await get(a.app, a.t, a.headers, '/app/modules/mail')).text();
    expect(ok).toContain('Pick a sending domain first.');
    expect(ok).toContain('href="/app/email"');
    expect(ok).toContain('Open email setup');

    const b = await setup([mk('javascript:alert(1)')]);
    b.t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'mail', 1)").run(b.t.org.id);
    const bad = await (await get(b.app, b.t, b.headers, '/app/modules/mail')).text();
    expect(bad).toContain('Pick a sending domain first.');
    expect(bad).not.toContain('javascript:');
    expect(bad).not.toContain('Open email setup');
  });

  it('answers an unknown id with the 404 page', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    for (const id of ['nope', 'LINKS', '..%2Fetc', 'links%20']) {
      const res = await get(app, t, headers, `/app/modules/${id}`);
      expect(res.status).toBe(404);
      const html = await res.text();
      expect(html).toContain('Page not found');
      expect(html).toContain('There is no module with that name');
    }
  });
});

describe('turning a module on and off', () => {
  it('turns one on, writes an audit entry, and sends the person back to the list with a message', async () => {
    const { t, app, headers } = await setup([fake('links', { name: 'Links' }), fake('forms')]);
    const res = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1', view: 'list', q: '', filter: 'all' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/modules');
    expect(flashOf(res)).toEqual({ kind: 'ok', message: 'Links is on. It shows up in the sidebar.' });
    expect(await moduleState(t.env, t.org.id, 'links')).toMatchObject({ enabled: true });
    expect(await moduleState(t.env, t.org.id, 'forms')).toMatchObject({ enabled: false });
    expect(audits(t)).toEqual([
      expect.objectContaining({ action: 'module.enabled', target_type: 'module', target_id: 'links', summary: 'Turned on Links' }),
    ]);
  });

  it('turns it off, keeps the data and the sample flag, and audits it', async () => {
    const mod = fake('notes', { name: 'Notes', tables: ['notes_items'] });
    const { t, app, headers } = await setup([mod]);
    t.sqlite.exec('CREATE TABLE notes_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT)');
    t.sqlite.prepare("INSERT INTO notes_items (id, org_id, title) VALUES ('n1', ?, 'Keep me')").run(t.org.id);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, sample, enabled_at) VALUES (?, 'notes', 1, 1, 5)").run(t.org.id);
    const res = await post(app, t, headers, '/app/modules/notes/toggle', { enabled: '0' });
    expect(res.status).toBe(303);
    expect(flashOf(res)?.message).toBe('Notes is off. Your data is kept, and it comes back when you turn it on.');
    expect(await moduleState(t.env, t.org.id, 'notes')).toMatchObject({ enabled: false, sample: true });
    expect(t.sqlite.prepare('SELECT title FROM notes_items WHERE org_id = ?').all(t.org.id)).toEqual([{ title: 'Keep me' }]);
    expect(audits(t).map((a) => a.action)).toEqual(['module.disabled']);
  });

  it('asks before turning off and says the data is kept', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'links', 1)").run(t.org.id);
    const html = await (await get(app, t, headers, '/app/modules')).text();
    expect(html).toContain('id="confirm-off-links"');
    expect(html).toContain('Turn off Links?');
    expect(html).toContain(TURN_OFF_NOTE);
    const detail = await (await get(app, t, headers, '/app/modules/links')).text();
    expect(detail).toContain('id="confirm-off-links"');
    expect(detail).toContain(TURN_OFF_NOTE);
  });

  it('does nothing twice: a repeated post says so and adds no audit entry', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1' });
    const again = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1' });
    expect(again.status).toBe(303);
    expect(flashOf(again)).toEqual({ kind: 'info', message: 'Links is already on.' });
    const off = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '0' });
    const offAgain = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '0' });
    expect(flashOf(off)?.kind).toBe('ok');
    expect(flashOf(offAgain)).toEqual({ kind: 'info', message: 'Links is already off.' });
    expect(audits(t).map((a) => a.action)).toEqual(['module.enabled', 'module.disabled']);
  });

  it('keeps the search and filter when it sends the person back, and goes to the detail page from there', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    const list = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1', view: 'list', q: 'li nks', filter: 'off' });
    expect(list.headers.get('location')).toBe('/app/modules?q=li+nks&filter=off');
    const detail = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '0', view: 'detail' });
    expect(detail.headers.get('location')).toBe('/app/modules/links');
  });

  it('never redirects anywhere but the modules screen', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    const res = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1', view: 'https://evil.example.com', q: '//evil.example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/modules?q=%2F%2Fevil.example.com');
  });

  it('answers 404 for a module that does not exist and creates no row', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    for (const id of ['ghost', 'LINKS', 'overview']) {
      const res = await post(app, t, headers, `/app/modules/${id}/toggle`, { enabled: '1' });
      expect(res.status).toBe(404);
      expect(await res.text()).toContain('There is no module with that name');
    }
    expect(enabledRows(t)).toEqual([]);
    expect(audits(t)).toEqual([]);
  });

  it('rejects a body it does not understand with 422 and changes nothing', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    const res = await post(app, t, headers, '/app/modules/links/toggle', { enabled: 'maybe' });
    expect(res.status).toBe(422);
    const none = await post(app, t, headers, '/app/modules/links/toggle', {});
    expect(none.status).toBe(422);
    expect(enabledRows(t)).toEqual([]);
  });

  it('refuses members and viewers on the server, not just in the page', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const { t, app, headers } = await setup([fake('links')], role);
      const res = await post(app, t, headers, '/app/modules/links/toggle', { enabled: '1' });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Only workspace admins can do that');
      expect(enabledRows(t)).toEqual([]);
      expect(audits(t)).toEqual([]);
    }
  });

  it('blocks a post from another site', async () => {
    const { t, app, headers } = await setup([fake('links')]);
    const res = await post(app, t, { ...headers, origin: 'https://evil.example.com' }, '/app/modules/links/toggle', { enabled: '1' });
    expect(res.status).toBe(403);
    expect(enabledRows(t)).toEqual([]);
  });

  it('sends a signed-out post to 401', async () => {
    registerModules([fake('links')]);
    const t = createTestEnv();
    const app = createApp({ screens: { modules: screen } });
    const res = await post(app, t, { origin: ORIGIN }, '/app/modules/links/toggle', { enabled: '1' });
    expect(res.status).toBe(401);
  });

  it('keeps one workspace separate from another', async () => {
    registerModules([fake('links'), fake('forms')]);
    const t = createTestEnv();
    const app = createApp({ screens: { modules: screen } });
    const a = await createTestSession(t.env, { role: 'admin', orgId: 'org_a' });
    const b = await createTestSession(t.env, { role: 'admin', orgId: 'org_b' });

    await post(app, t, a.headers, '/app/modules/links/toggle', { enabled: '1' });
    await post(app, t, b.headers, '/app/modules/links/toggle', { enabled: '1' });
    await post(app, t, b.headers, '/app/modules/forms/toggle', { enabled: '1' });
    await post(app, t, a.headers, '/app/modules/links/toggle', { enabled: '0' });

    expect(enabledRows(t, 'org_a')).toEqual(['links:0']);
    expect(enabledRows(t, 'org_b')).toEqual(['forms:1', 'links:1']);
    expect(audits(t, 'org_a').map((x) => x.action)).toEqual(['module.enabled', 'module.disabled']);
    expect(audits(t, 'org_b').map((x) => x.action)).toEqual(['module.enabled', 'module.enabled']);

    const htmlB = await (await get(app, t, b.headers, '/app/modules?filter=on')).text();
    expect([...htmlB.matchAll(/data-id="([a-z-]+)"/g)].map((m) => m[1])).toEqual(['forms', 'links']);
    const htmlA = await (await get(app, t, a.headers, '/app/modules?filter=on')).text();
    expect(htmlA).toContain('No modules are on yet');
  });
});

describe('sample data', () => {
  function sampleModule() {
    const calls: string[] = [];
    const def = fake('crm', {
      name: 'CRM',
      sampleData: async (ctx) => {
        calls.push(`add:${ctx.org.id}`);
      },
      clearSampleData: async (ctx) => {
        calls.push(`clear:${ctx.org.id}`);
      },
    });
    return { def, calls };
  }

  it('only offers it to modules that declare both halves', async () => {
    const half = fake('half', { sampleData: async () => {} });
    const { def } = sampleModule();
    const { t, app, headers } = await setup([half, def, fake('plain')]);
    expect(await (await get(app, t, headers, '/app/modules/half')).text()).not.toContain('Sample data');
    expect(await (await get(app, t, headers, '/app/modules/plain')).text()).not.toContain('Sample data');
    const html = await (await get(app, t, headers, '/app/modules/crm')).text();
    expect(html).toContain('Sample data');
    expect(html).toContain('Turn the module on to add sample data.');
    expect(html).toContain('disabled');
  });

  it('adds sample data, remembers it, and audits it', async () => {
    const { def, calls } = sampleModule();
    const { t, app, headers } = await setup([def]);
    await post(app, t, headers, '/app/modules/crm/toggle', { enabled: '1' });
    const res = await post(app, t, headers, '/app/modules/crm/sample', { sample: '1' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/modules/crm');
    expect(flashOf(res)).toEqual({ kind: 'ok', message: 'Sample data added to CRM.' });
    expect(calls).toEqual([`add:${t.org.id}`]);
    expect(await moduleState(t.env, t.org.id, 'crm')).toMatchObject({ enabled: true, sample: true });
    const html = await (await get(app, t, headers, '/app/modules/crm')).text();
    expect(html).toContain('CRM is showing sample data.');
    expect(html).toContain('id="confirm-sample-off-crm"');
    expect(html).toContain('Anything you created yourself stays.');
    expect(audits(t).map((a) => a.action)).toEqual(['module.enabled', 'module.sample_added']);
  });

  it('removes it with the module’s own clear function', async () => {
    const { def, calls } = sampleModule();
    const { t, app, headers } = await setup([def]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, sample) VALUES (?, 'crm', 1, 1)").run(t.org.id);
    const res = await post(app, t, headers, '/app/modules/crm/sample', { sample: '0' });
    expect(flashOf(res)?.message).toBe('Sample data removed from CRM.');
    expect(calls).toEqual([`clear:${t.org.id}`]);
    expect(await moduleState(t.env, t.org.id, 'crm')).toMatchObject({ sample: false });
    expect(audits(t).map((a) => a.action)).toEqual(['module.sample_removed']);
  });

  it('does not add twice', async () => {
    const { def, calls } = sampleModule();
    const { t, app, headers } = await setup([def]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled, sample) VALUES (?, 'crm', 1, 1)").run(t.org.id);
    const res = await post(app, t, headers, '/app/modules/crm/sample', { sample: '1' });
    expect(flashOf(res)?.kind).toBe('info');
    expect(calls).toEqual([]);
    expect(audits(t)).toEqual([]);
  });

  it('leaves the flag alone and says so when the module’s function fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const def = fake('crm', {
      name: 'CRM',
      sampleData: async () => {
        throw new Error('disk full');
      },
      clearSampleData: async () => {},
    });
    const { t, app, headers } = await setup([def]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'crm', 1)").run(t.org.id);
    const res = await post(app, t, headers, '/app/modules/crm/sample', { sample: '1' });
    expect(res.status).toBe(303);
    const flash = flashOf(res);
    expect(flash?.kind).toBe('error');
    expect(flash?.message).toContain('We couldn’t add the sample data for CRM. Nothing was changed.');
    expect(flash?.message).not.toContain('disk full');
    expect(await moduleState(t.env, t.org.id, 'crm')).toMatchObject({ sample: false });
    expect(audits(t)).toEqual([]);
  });

  it('refuses a module with no sample data, a module that is off, and an unknown module', async () => {
    const { def } = sampleModule();
    const { t, app, headers } = await setup([def, fake('plain')]);
    t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'plain', 1)").run(t.org.id);
    expect((await post(app, t, headers, '/app/modules/plain/sample', { sample: '1' })).status).toBe(400);
    const off = await post(app, t, headers, '/app/modules/crm/sample', { sample: '1' });
    expect(off.status).toBe(409);
    expect(await off.text()).toContain('Turn CRM on first');
    expect((await post(app, t, headers, '/app/modules/ghost/sample', { sample: '1' })).status).toBe(404);
    expect((await post(app, t, headers, '/app/modules/crm/sample', { sample: 'x' })).status).toBe(422);
  });

  it('refuses members and viewers', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const { def, calls } = sampleModule();
      const { t, app, headers } = await setup([def], role);
      t.sqlite.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'crm', 1)").run(t.org.id);
      expect((await post(app, t, headers, '/app/modules/crm/sample', { sample: '1' })).status).toBe(403);
      expect(calls).toEqual([]);
    }
  });
});
