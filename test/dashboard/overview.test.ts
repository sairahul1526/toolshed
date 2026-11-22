import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { emit } from '../../src/core/events';
import { defineModule, type ModuleDef } from '../../src/core/module';
import { registerModules, setModuleEnabled } from '../../src/core/registry';
import { setSetting } from '../../src/core/settings';
import overview from '../../src/dashboard/overview';
import { eventLabel } from '../../src/dashboard/overview/view';
import type { Role } from '../../src/env';
import { countQueries, createTestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

afterEach(() => registerModules([]));

const OTHER = 'org_other';
const DAY = 86_400_000;

function fake(id: string, extra: Partial<ModuleDef> = {}): ModuleDef {
  return defineModule({
    id,
    name: `Module ${id}`,
    description: `The ${id} module`,
    icon: 'link',
    category: 'growth',
    version: '0.1.0',
    ...extra,
  });
}

/** A module needs a dashboard to appear in the sidebar and on Overview. */
async function withDashboard(def: ModuleDef): Promise<ModuleDef> {
  const { Hono } = await import('hono');
  return { ...def, dashboard: new Hono() };
}

async function setup(modules: ModuleDef[] = [], vars: Record<string, string> = {}) {
  const t = createTestEnv(vars);
  registerModules(await Promise.all(modules.map(withDashboard)));
  for (const m of modules) await setModuleEnabled(t.env, t.org.id, m.id, true);
  const app = createApp({ screens: { overview } });
  return { t, app };
}

async function get(t: TestEnv, app: ReturnType<typeof createApp>, path = '/app', role: Role = 'owner') {
  const { headers } = await createTestSession(t.env, { role });
  const res = await app.request(path, { headers }, t.env);
  return { res, html: await res.text(), headers };
}

describe('access', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const { t, app } = await setup();
    const res = await app.request('/app', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it.each<Role>(['owner', 'admin', 'member', 'viewer'])('shows the page to a %s', async (role) => {
    const { t, app } = await setup();
    const { res, html } = await get(t, app, '/app', role);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Overview');
    expect(html).toContain('Test Workspace');
  });

  it('shows the checklist and invite button to admins only', async () => {
    const { t, app } = await setup();
    for (const role of ['owner', 'admin'] as const) {
      const { html } = await get(t, app, '/app', role);
      expect(html).toContain('Finish setting up');
      expect(html).toContain('Invite people');
    }
    for (const role of ['member', 'viewer'] as const) {
      const { html } = await get(t, app, '/app', role);
      expect(html).not.toContain('Finish setting up');
      expect(html).not.toContain('Invite people');
      expect(html).not.toContain('Dismiss');
    }
  });
});

describe('no modules on', () => {
  it('shows one clear step to an admin', async () => {
    const { t, app } = await setup();
    const { html } = await get(t, app);
    expect(html).toContain('No modules are on yet');
    expect(html).toContain('Browse modules');
    expect(html).toContain('href="/app/modules"');
    expect(html).toContain('No activity yet');
  });

  it('tells a viewer to ask an admin instead of linking to a screen they cannot use', async () => {
    const { t, app } = await setup();
    const { html } = await get(t, app, '/app', 'viewer');
    expect(html).toContain('Ask a workspace admin to turn on a module');
    expect(html).not.toContain('Browse modules');
  });
});

describe('module cards', () => {
  const links = fake('links', {
    name: 'Links',
    count: async () => 42,
    overview: async () => [
      { label: 'Clicks today', value: '1,204', delta: '+12% vs last week', href: '/app/links' },
      { label: 'Top link', value: '/launch' },
      { label: 'Third', value: 'ignored' },
    ],
  });
  const forms = fake('forms', {
    name: 'Forms',
    icon: 'form',
    setup: async () => ({ status: 'needs_setup', reason: 'Add a sending address first.', action: { label: 'Open email', href: '/app/email' } }),
  });

  it('draws a card per turned-on module with its number, activity and setup status', async () => {
    const { t, app } = await setup([links, forms]);
    const now = Date.now();
    await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked', count: 5, at: now });
    await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked', count: 3, at: now - 2 * DAY });
    const { html } = await get(t, app);
    expect(html).toContain('>Links<');
    expect(html).toContain('>Forms<');
    expect(html).toContain('>42<');
    expect(html).toContain('8 events in the last 30 days.');
    expect(html).toContain('Clicks today');
    expect(html).toContain('+12% vs last week');
    expect(html).toContain('Top link');
    expect(html).not.toContain('ignored');
    expect(html).toContain('Ready');
    expect(html).toContain('Needs setup');
    expect(html).toContain('Add a sending address first.');
    expect(html).toContain('href="/app/email"');
    expect(html).toContain('href="/app/links"');
    // Quiet days stay in the chart as zeros, so it always has one value per day.
    expect(html.match(/Activity per day, last 30 days: ([\d, ]+)"/)![1]!.split(', ')).toHaveLength(30);
  });

  it('leaves modules that are off out', async () => {
    const { t, app } = await setup([links, forms]);
    await setModuleEnabled(t.env, t.org.id, 'forms', false);
    const { html } = await get(t, app);
    expect(html).toContain('>Links<');
    expect(html).not.toContain('>Forms<');
  });

  it('says so and draws no chart when a module has no activity in the range', async () => {
    const { t, app } = await setup([links]);
    await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked', at: Date.now() - 40 * DAY });
    const { html } = await get(t, app);
    expect(html).toContain('No activity in the last 30 days.');
    expect(html).not.toContain('Activity per day');
  });

  it('keeps zero days in the chart when only some days are quiet', async () => {
    const { t, app } = await setup([links]);
    await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked', at: Date.now() });
    const { html } = await get(t, app, '/app?days=7');
    const values = html.match(/Activity per day, last 7 days: ([\d, ]+)"/)![1]!.split(', ');
    expect(values).toEqual(['0', '0', '0', '0', '0', '0', '1']);
  });

  it('shows a dash and a working page when a module count throws', async () => {
    const broken = fake('broken', { name: 'Broken', count: async () => { throw new Error('boom'); } });
    const { t, app } = await setup([broken, links]);
    const { res, html } = await get(t, app);
    expect(res.status).toBe(200);
    expect(html).toContain('>Broken<');
    expect(html).toContain('>–<');
    expect(html).toContain('>42<');
  });

  it('keeps going when a module setup check or stats call throws', async () => {
    const bad = fake('bad', {
      name: 'Bad',
      setup: async () => { throw new Error('nope'); },
      overview: async () => { throw new Error('nope'); },
    });
    const { t, app } = await setup([bad]);
    const { res, html } = await get(t, app);
    expect(res.status).toBe(200);
    expect(html).toContain('Needs setup');
    expect(html).toContain('We couldn’t check this module’s setup');
  });

  it('reads each module count once for the whole page', async () => {
    const count = vi.fn(async () => 1);
    const { t, app } = await setup([fake('once', { name: 'Once', count })]);
    await get(t, app);
    expect(count).toHaveBeenCalledTimes(1);
  });

  it('shows 12 modules at once within the free plan budget', async () => {
    const many = Array.from({ length: 12 }, (_, i) => fake(`mod-${String(i).padStart(2, '0')}`, { name: `Module ${i}`, count: async () => i }));
    const { t, app } = await setup(many);
    for (const m of many) await emit(t.env, { orgId: t.org.id, module: m.id, name: 'thing.happened' });
    const { headers } = await createTestSession(t.env, { role: 'owner' });
    const { result, queries } = await countQueries(t.env, async () => app.request('/app', { headers }, t.env));
    const html = await result.text();
    expect(result.status).toBe(200);
    for (let i = 0; i < 12; i++) expect(html).toContain(`>Module ${i}<`);
    // One module_state read, one events read per module, plus a handful for the page.
    expect(queries.length).toBeLessThanOrEqual(50);
  });

  it('escapes and truncates long, odd and hostile names', async () => {
    const long = 'L'.repeat(300);
    const odd = fake('odd', { name: '<script>alert(1)</script> 日本語 😀', icon: 'not-an-icon' });
    const huge = fake('huge', { name: long, count: async () => 9_999_999_999 });
    const { t, app } = await setup([odd, huge]);
    const { html } = await get(t, app);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; 日本語 😀');
    expect(html).toContain(long);
    expect(html).toContain('9,999,999,999');
    expect(html).toContain('class="trunc"');
    expect(html).toContain('#i-layers');
  });
});

describe('date range', () => {
  it('offers 7, 30 and 90 days and marks the chosen one', async () => {
    const { t, app } = await setup([fake('links', { name: 'Links' })]);
    const { html } = await get(t, app, '/app?days=90');
    expect(html).toContain('href="/app?days=7"');
    expect(html).toContain('href="/app"');
    expect(html).toContain('href="/app?days=90"');
    expect(html).toMatch(/href="\/app\?days=90" aria-current="page"/);
  });

  it.each(['abc', '0', '8', '999', '-7', '7.5', ''])('falls back to 30 days for days=%s', async (value) => {
    const { t, app } = await setup([fake('links', { name: 'Links' })]);
    await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked' });
    const { res, html } = await get(t, app, `/app?days=${value}`);
    expect(res.status).toBe(200);
    expect(html).toContain('in the last 30 days.');
  });
});

describe('recent activity', () => {
  it('lists the latest ten events for this workspace, newest first, with relative times', async () => {
    const { t, app } = await setup([fake('links', { name: 'Links' })]);
    const now = Date.now();
    for (let i = 0; i < 12; i++) await emit(t.env, { orgId: t.org.id, module: 'links', name: 'link.clicked', subject: `lnk_${i}`, at: now - (12 - i) * 60_000 });
    await emit(t.env, { orgId: OTHER, module: 'links', name: 'secret.thing', subject: 'other-workspace-row', at: now });
    const { html } = await get(t, app);
    expect(html).toContain('Link clicked');
    expect(html).toContain('lnk_11');
    expect(html).toContain('lnk_2');
    expect(html).not.toContain('lnk_1<');
    expect(html).not.toContain('lnk_0');
    expect(html.indexOf('lnk_11')).toBeLessThan(html.indexOf('lnk_10'));
    expect(html).not.toContain('other-workspace-row');
    expect(html).not.toContain('Secret thing');
    expect(html).toMatch(/\d+ minutes? ago/);
  });

  it('escapes subjects and shows the raw id for a module that is no longer installed', async () => {
    const { t, app } = await setup();
    await emit(t.env, { orgId: t.org.id, module: 'retired', name: 'page.viewed', subject: '<img src=x onerror=alert(1)>' });
    const { html } = await get(t, app);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('retired');
    expect(html).toContain('Page viewed');
  });

  it('labels event names in plain words', () => {
    expect(eventLabel('link.clicked')).toBe('Link clicked');
    expect(eventLabel('form_response.created')).toBe('Form response created');
    expect(eventLabel('')).toBe('Something happened');
  });
});

describe('getting-started checklist', () => {
  const links = fake('links', { name: 'Links' });

  function stepState(html: string, title: string): 'done' | 'todo' {
    const at = html.indexOf(title);
    expect(at).toBeGreaterThan(-1);
    const li = html.lastIndexOf('<li', at);
    return html.slice(li, li + 20).includes('class="done"') ? 'done' : 'todo';
  }

  it('starts with only the steps that are really done ticked', async () => {
    const { t, app } = await setup();
    const { html } = await get(t, app);
    expect(html).toContain('1 of 4 done.');
    expect(stepState(html, 'Set up email sending')).toBe('done');
    expect(stepState(html, 'Turn on a module')).toBe('todo');
    expect(stepState(html, 'Choose your look')).toBe('todo');
    expect(stepState(html, 'Invite a teammate')).toBe('todo');
    for (const href of ['/app/modules', '/app/appearance', '/app/members']) expect(html).toContain(`href="${href}"`);
  });

  it('asks for email setup in production when nothing can send', async () => {
    const { t, app } = await setup([], { ENVIRONMENT: 'production' });
    const { html } = await get(t, app);
    expect(stepState(html, 'Set up email sending')).toBe('todo');
    expect(html).toContain('href="/app/email"');
  });

  it('ticks a step when its state changes', async () => {
    const { t, app } = await setup([links]);
    await setSetting(t.env, t.org.id, 'appearance', { accent: 'violet' });
    const { html } = await get(t, app);
    expect(stepState(html, 'Turn on a module')).toBe('done');
    expect(stepState(html, 'Choose your look')).toBe('done');
    expect(stepState(html, 'Invite a teammate')).toBe('todo');
    expect(html).toContain('3 of 4 done.');
  });

  it('counts a teammate only from this workspace', async () => {
    const { t, app } = await setup();
    await createTestSession(t.env, { role: 'member', orgId: OTHER });
    await createTestSession(t.env, { role: 'member', orgId: OTHER });
    expect(stepState((await get(t, app)).html, 'Invite a teammate')).toBe('todo');
    await createTestSession(t.env, { role: 'member' });
    expect(stepState((await get(t, app)).html, 'Invite a teammate')).toBe('done');
  });

  it('treats saved defaults as unchanged', async () => {
    const { t, app } = await setup();
    await setSetting(t.env, t.org.id, 'appearance', { accent: 'lime', mode: 'system', junk: 'x' });
    const { html } = await get(t, app);
    expect(stepState(html, 'Choose your look')).toBe('todo');
  });

  it('hides itself once every step is done', async () => {
    const { t, app } = await setup([links]);
    await setSetting(t.env, t.org.id, 'appearance', { mode: 'dark' });
    await createTestSession(t.env, { role: 'member', email: 'second@example.com' });
    const { html } = await get(t, app);
    expect(html).not.toContain('Finish setting up');
  });

  describe('dismissing', () => {
    it('hides it for the workspace, writes an audit entry and thanks the admin', async () => {
      const { t, app } = await setup();
      const { headers } = await createTestSession(t.env, { role: 'admin' });
      const res = await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'days=7' }, t.env);
      expect(res.status).toBe(303);
      expect(res.headers.get('location')).toBe('/app?days=7');
      const row = t.sqlite.prepare("SELECT value FROM settings WHERE scope = ? AND key = 'overview.checklistDismissed'").get(t.org.id) as { value: string };
      expect(row.value).toBe('true');
      const log = t.sqlite.prepare("SELECT action, org_id, target_id FROM audit_log WHERE action = 'overview.checklist_dismissed'").all() as { org_id: string; target_id: string }[];
      expect(log).toHaveLength(1);
      expect(log[0]!.org_id).toBe(t.org.id);
      const after = await app.request('/app', { headers: { ...headers, cookie: `${headers.cookie}; ${res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')}` } }, t.env);
      const html = await after.text();
      expect(html).not.toContain('Finish setting up');
      expect(html).toContain('Checklist hidden.');
    });

    it('redirects to the default range when the range field is junk', async () => {
      const { t, app } = await setup();
      const { headers } = await createTestSession(t.env, { role: 'owner' });
      const res = await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'days=%3Cscript%3E' }, t.env);
      expect(res.headers.get('location')).toBe('/app');
    });

    it.each<Role>(['member', 'viewer'])('refuses a %s', async (role) => {
      const { t, app } = await setup();
      const { headers } = await createTestSession(t.env, { role });
      const res = await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers }, t.env);
      expect(res.status).toBe(403);
      expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM settings WHERE key = 'overview.checklistDismissed'").get()).toEqual({ n: 0 });
    });

    it('refuses a post from another site and a signed-out post', async () => {
      const { t, app } = await setup();
      const { headers } = await createTestSession(t.env, { role: 'admin' });
      const cross = await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers: { ...headers, origin: 'https://evil.example.com' } }, t.env);
      expect(cross.status).toBe(403);
      const anon = await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers: { origin: 'http://localhost' } }, t.env);
      expect(anon.status).toBe(401);
    });

    it('does not hide the checklist of another workspace', async () => {
      const { t, app } = await setup();
      const a = await createTestSession(t.env, { role: 'admin' });
      await app.request('/app/overview/dismiss-checklist', { method: 'POST', headers: a.headers }, t.env);
      const b = await createTestSession(t.env, { role: 'admin', orgId: OTHER });
      const html = await (await app.request('/app', { headers: b.headers }, t.env)).text();
      expect(html).toContain('Finish setting up');
    });
  });
});
