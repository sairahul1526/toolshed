import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { defineModule, type ModuleDef } from '../../src/core/module';
import { HIDDEN_SETTING, SAMPLE_SETTING, buildSetupSteps, progressLine, summarise } from '../../src/core/onboarding';
import { moduleState, registerModules, setModuleEnabled, setModuleSample } from '../../src/core/registry';
import { getSetting, setSetting } from '../../src/core/settings';
import overview from '../../src/dashboard/overview';
import welcome from '../../src/dashboard/welcome';
import type { Role } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

afterEach(() => registerModules([]));

const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' };

function fake(id: string, extra: Partial<ModuleDef> = {}): ModuleDef {
  return defineModule({
    id,
    name: `Module ${id}`,
    description: `The ${id} module`,
    icon: 'link',
    category: 'growth',
    version: '0.1.0',
    onboarding: { title: `Start ${id}`, body: `What ${id} does.` },
    ...extra,
  });
}

async function setup(modules: ModuleDef[] = [], vars: Record<string, string> = {}) {
  const { Hono } = await import('hono');
  const t = createTestEnv(vars);
  registerModules(modules.map((m) => ({ ...m, dashboard: new Hono() })));
  const app = createApp({ screens: { overview, welcome } });
  return { t, app };
}

type App = ReturnType<typeof createApp>;

async function get(t: TestEnv, app: App, role: Role = 'owner', opts: { instanceOwner?: boolean } = {}) {
  const { headers, user } = await createTestSession(t.env, { role, ...opts });
  const res = await app.request('/app/welcome', { headers }, t.env);
  return { res, html: await res.text(), headers, user };
}

function post(t: TestEnv, app: App, headers: Record<string, string>, path: string, body: Record<string, string>) {
  return app.request(`/app/welcome${path}`, { method: 'POST', headers: { ...headers, ...FORM }, body: new URLSearchParams(body) }, t.env);
}

/** The message a redirect leaves for the next page. */
function flashOf(res: Response): string {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ts_flash='))?.split(';')[0]?.slice('ts_flash='.length);
  return raw ? (JSON.parse(decodeURIComponent(decodeURIComponent(raw))) as { message: string }).message : '';
}

function stepState(html: string, title: string): 'done' | 'todo' {
  const at = html.indexOf(`<b>${title}</b>`);
  expect(at).toBeGreaterThan(-1);
  const li = html.lastIndexOf('<li', at);
  return html.slice(li, li + 20).includes('class="done"') ? 'done' : 'todo';
}

describe('setup steps', () => {
  const base = { instanceOwner: true, workspaceName: 'Shed', email: 'off' as const, members: 1, modulesOn: 0, passkeys: 0 };

  it('ticks only what is really there', () => {
    const fresh = summarise(buildSetupSteps(base), false);
    expect(fresh.steps.map((s) => [s.id, s.done])).toEqual([
      ['claim', true],
      ['workspace', true],
      ['email', false],
      ['teammate', false],
      ['module', false],
      ['passkey', false],
    ]);
    expect([fresh.done, fresh.total, fresh.percent, fresh.minutesLeft]).toEqual([2, 6, 33, 6]);
    expect(progressLine(fresh)).toBe('2 of 6 done. About 6 minutes left.');

    const all = summarise(buildSetupSteps({ ...base, email: 'live', members: 3, modulesOn: 2, passkeys: 1 }), false);
    expect(all.percent).toBe(100);
    expect(progressLine(all)).toBe('All 6 done. Nothing left to set up.');
  });

  it('leaves the claim step out for an admin who did not claim the install', () => {
    const steps = buildSetupSteps({ ...base, instanceOwner: false });
    expect(steps.map((s) => s.id)).toEqual(['workspace', 'email', 'teammate', 'module', 'passkey']);
  });

  it('says a minute, not "1 minutes"', () => {
    const one = summarise(buildSetupSteps({ ...base, email: 'live', members: 2, modulesOn: 1 }), false);
    expect(progressLine(one)).toBe('5 of 6 done. About a minute left.');
  });
});

describe('access', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const { t, app } = await setup();
    const res = await app.request('/app/welcome', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it.each<Role>(['owner', 'admin'])('shows the page to a %s', async (role) => {
    const { t, app } = await setup([fake('links')]);
    const { res, html } = await get(t, app, role);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Welcome to Toolshed.');
    expect(html).toContain('Finish setting up');
  });

  it.each<Role>(['member', 'viewer'])('sends a %s to Overview and refuses their changes', async (role) => {
    const { t, app } = await setup([fake('links')]);
    const { res, headers } = await get(t, app, role);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app');
    for (const [path, body] of [
      ['/start', { module: 'links' }],
      ['/sample', { sample: '1' }],
      ['/sidebar', { hidden: '1' }],
    ] as const) {
      expect((await post(t, app, headers, path, body)).status).toBe(403);
    }
    expect((await moduleState(t.env, t.org.id, 'links')).enabled).toBe(false);
  });

  it('refuses a form sent from another site', async () => {
    const { t, app } = await setup([fake('links')]);
    const { headers } = await get(t, app);
    const res = await app.request('/app/welcome/start', { method: 'POST', headers: { ...headers, ...FORM, origin: 'https://evil.example' }, body: new URLSearchParams({ module: 'links' }) }, t.env);
    expect(res.status).toBe(403);
    expect((await moduleState(t.env, t.org.id, 'links')).enabled).toBe(false);
  });
});

describe('the page', () => {
  it('shows a card per module that offers one, and counts every module', async () => {
    const { t, app } = await setup([fake('links'), fake('forms'), fake('quiet', { onboarding: undefined })]);
    const { html } = await get(t, app);
    expect(html).toContain('<b>Start links</b>');
    expect(html).toContain('<b>Start forms</b>');
    expect(html).not.toContain('Start quiet');
    expect(html).toContain('See all 3 modules');
    expect(html).toContain('name="module" value="links"');
  });

  it('turns the card of a module that is already on into a link', async () => {
    const { t, app } = await setup([fake('links')]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    const { html } = await get(t, app);
    expect(html).not.toContain('name="module" value="links"');
    expect(html).toMatch(/<a class="choice" href="\/app\/links">/);
    expect(stepState(html, 'Turn on a module')).toBe('done');
  });

  it('starts a fresh install at the steps that are done', async () => {
    const { t, app } = await setup([fake('links')], { ENVIRONMENT: 'production' });
    const { html } = await get(t, app, 'owner', { instanceOwner: true });
    expect(html).toContain('2 of 6 done. About 6 minutes left.');
    expect(html).toContain('aria-valuenow="33"');
    expect(stepState(html, 'Claim this Toolshed')).toBe('done');
    expect(stepState(html, 'Name your workspace')).toBe('done');
    expect(stepState(html, 'Verify a sending domain')).toBe('todo');
    expect(stepState(html, 'Invite a teammate')).toBe('todo');
    expect(stepState(html, 'Turn on a module')).toBe('todo');
    expect(stepState(html, 'Add a passkey')).toBe('todo');
    for (const href of ['/app/email', '/app/members#invite', '/app/modules', '/app/account?tab=security']) expect(html).toContain(`href="${href}"`);
    // The sidebar carries the same count.
    expect(html).toMatch(/href="\/app\/welcome"[^>]*aria-current="page"[\s\S]*?2\/6/);
  });

  it('ticks the teammate and passkey steps when they exist', async () => {
    const { t, app } = await setup();
    const first = await get(t, app);
    await createTestSession(t.env, { role: 'member', email: 'second@example.com' });
    t.sqlite
      .prepare('INSERT INTO "passkey" ("id", "publicKey", "userId", "credentialID", "counter", "deviceType", "backedUp", "createdAt") VALUES (?, ?, ?, ?, 0, ?, 0, ?)')
      .run('pk_1', 'key', first.user.id, 'cred_1', 'singleDevice', new Date().toISOString());
    const html = await (await app.request('/app/welcome', { headers: first.headers }, t.env)).text();
    expect(stepState(html, 'Invite a teammate')).toBe('done');
    expect(stepState(html, 'Add a passkey')).toBe('done');
  });

  it('shows the Updates link to the install owner only', async () => {
    const { t, app } = await setup();
    expect((await get(t, app, 'owner', { instanceOwner: true })).html).toContain('href="/app/updates"');
    const b = await setup();
    expect((await get(b.t, b.app, 'admin')).html).not.toContain('class="select-btn" href="/app/updates"');
  });

  it('escapes a workspace name that looks like markup', async () => {
    const { t, app } = await setup();
    const { headers } = await get(t, app);
    t.sqlite.prepare('UPDATE "organization" SET "name" = ? WHERE "id" = ?').run('<img src=x onerror=alert(1)>', t.org.id);
    const html = await (await app.request('/app/welcome', { headers }, t.env)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });
});

describe('starting a module from a card', () => {
  it('turns it on, adds sample rows, writes the audit line and opens it', async () => {
    const sampleData = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData, clearSampleData: async () => {} })]);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/start', { module: 'links' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/links');
    expect(await moduleState(t.env, t.org.id, 'links')).toMatchObject({ enabled: true, sample: true });
    expect(sampleData).toHaveBeenCalledTimes(1);
    const log = t.sqlite.prepare("SELECT org_id, target_id, meta FROM audit_log WHERE action = 'module.enabled'").get() as { org_id: string; target_id: string; meta: string };
    expect(log).toMatchObject({ org_id: t.org.id, target_id: 'links' });
    expect(JSON.parse(log.meta)).toMatchObject({ sample: true, from: 'welcome' });
  });

  it('follows the module’s own first page', async () => {
    const { t, app } = await setup([fake('forms', { onboarding: { title: 'Build a form', body: 'x', href: '/app/forms/new' } })]);
    const { headers } = await get(t, app);
    expect((await post(t, app, headers, '/start', { module: 'forms' })).headers.get('location')).toBe('/app/forms/new');
  });

  it('adds no sample rows when the switch is off', async () => {
    const sampleData = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData, clearSampleData: async () => {} })]);
    await setSetting(t.env, t.org.id, SAMPLE_SETTING, false);
    const { headers } = await get(t, app);
    await post(t, app, headers, '/start', { module: 'links' });
    expect(sampleData).not.toHaveBeenCalled();
    expect(await moduleState(t.env, t.org.id, 'links')).toMatchObject({ enabled: true, sample: false });
  });

  it('still opens the module when its sample rows fail', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { t, app } = await setup([fake('links', { sampleData: async () => Promise.reject(new Error('boom')), clearSampleData: async () => {} })]);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/start', { module: 'links' });
    expect(res.status).toBe(303);
    expect(await moduleState(t.env, t.org.id, 'links')).toMatchObject({ enabled: true, sample: false });
    quiet.mockRestore();
  });

  it('does nothing twice: a module that is on is only opened', async () => {
    const sampleData = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData, clearSampleData: async () => {} })]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/start', { module: 'links' });
    expect(res.headers.get('location')).toBe('/app/links');
    expect(sampleData).not.toHaveBeenCalled();
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'module.enabled'").get()).toEqual({ n: 0 });
  });

  it('adds one set of sample rows when the card is pressed twice at once', async () => {
    const sampleData = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData, clearSampleData: async () => {} })]);
    const { headers } = await get(t, app);
    const both = await Promise.all([post(t, app, headers, '/start', { module: 'links' }), post(t, app, headers, '/start', { module: 'links' })]);
    expect(both.map((r) => r.headers.get('location'))).toEqual(['/app/links', '/app/links']);
    expect(sampleData).toHaveBeenCalledTimes(1);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'module.enabled'").get()).toEqual({ n: 1 });
  });

  it('does not add a second set to a module that was turned off with its sample rows', async () => {
    const sampleData = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData, clearSampleData: async () => {} })]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    await setModuleSample(t.env, t.org.id, 'links', true);
    await setModuleEnabled(t.env, t.org.id, 'links', false);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/start', { module: 'links' });
    expect(res.headers.get('location')).toBe('/app/links');
    expect(sampleData).not.toHaveBeenCalled();
    expect(await moduleState(t.env, t.org.id, 'links')).toMatchObject({ enabled: true, sample: true });
  });

  it('answers 404 for a made-up module and one with no card', async () => {
    const { t, app } = await setup([fake('quiet', { onboarding: undefined })]);
    const { headers } = await get(t, app);
    expect((await post(t, app, headers, '/start', { module: 'nope' })).status).toBe(404);
    expect((await post(t, app, headers, '/start', { module: 'quiet' })).status).toBe(404);
    expect((await moduleState(t.env, t.org.id, 'quiet')).enabled).toBe(false);
  });
});

describe('the sample data switch', () => {
  it('is on for a new workspace and says where sample rows show', async () => {
    const { t, app } = await setup([fake('links', { name: 'Links', sampleData: async () => {}, clearSampleData: async () => {} })]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    await setModuleSample(t.env, t.org.id, 'links', true);
    const { html } = await get(t, app);
    expect(html).toMatch(/role="switch" aria-checked="true" aria-label="Sample data" name="sample" value="0"/);
    expect(html).toContain('Showing now in Links.');
  });

  it('turning it off clears every module that shows sample rows, and only those', async () => {
    const clearA = vi.fn(async () => {});
    const clearB = vi.fn(async () => {});
    const clearOff = vi.fn(async () => {});
    const { t, app } = await setup([
      fake('links', { sampleData: async () => {}, clearSampleData: clearA }),
      fake('forms', { sampleData: async () => {}, clearSampleData: clearB }),
      fake('mail', { sampleData: async () => {}, clearSampleData: clearOff }),
    ]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    await setModuleSample(t.env, t.org.id, 'links', true);
    await setModuleEnabled(t.env, t.org.id, 'forms', true);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/sample', { sample: '0' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/welcome');
    expect(clearA).toHaveBeenCalledTimes(1);
    expect(clearB).not.toHaveBeenCalled();
    expect(clearOff).not.toHaveBeenCalled();
    expect((await moduleState(t.env, t.org.id, 'links')).sample).toBe(false);
    expect(await getSetting(t.env, t.org.id, SAMPLE_SETTING, true)).toBe(false);
    const html = await (await app.request('/app/welcome', { headers }, t.env)).text();
    expect(html).toMatch(/aria-checked="false" aria-label="Sample data" name="sample" value="1"/);
    expect(flashOf(res)).toContain('Sample data removed from Module links.');
  });

  it('turning it on only changes what the cards do next: no rows go into a module in use', async () => {
    const add = vi.fn(async () => {});
    const { t, app } = await setup([fake('links', { sampleData: add, clearSampleData: async () => {} }), fake('forms', { sampleData: add, clearSampleData: async () => {} })]);
    await setSetting(t.env, t.org.id, SAMPLE_SETTING, false);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/sample', { sample: '1' });
    expect(flashOf(res)).toContain('Sample data is on.');
    expect(add).not.toHaveBeenCalled();
    expect((await moduleState(t.env, t.org.id, 'links')).sample).toBe(false);
    expect(await getSetting(t.env, t.org.id, SAMPLE_SETTING, false)).toBe(true);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'onboarding.sample_on'").get()).toEqual({ n: 1 });
    // The next card pressed does get them.
    await post(t, app, headers, '/start', { module: 'forms' });
    expect(add).toHaveBeenCalledTimes(1);
  });

  it('says which module failed and leaves its state alone', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { t, app } = await setup([fake('links', { name: 'Links', sampleData: async () => {}, clearSampleData: async () => Promise.reject(new Error('boom')) })]);
    await setModuleEnabled(t.env, t.org.id, 'links', true);
    await setModuleSample(t.env, t.org.id, 'links', true);
    const { headers } = await get(t, app);
    const res = await post(t, app, headers, '/sample', { sample: '0' });
    expect((await moduleState(t.env, t.org.id, 'links')).sample).toBe(true);
    expect(flashOf(res)).toContain('remove the sample data from Links');
    quiet.mockRestore();
  });

  it('refuses a value that is not on or off', async () => {
    const { t, app } = await setup();
    const { headers } = await get(t, app);
    expect((await post(t, app, headers, '/sample', { sample: 'maybe' })).status).toBe(422);
  });
});

describe('the sidebar entry', () => {
  it('can be hidden and put back, for this workspace only', async () => {
    const { t, app } = await setup();
    const a = await get(t, app);
    const b = await createTestSession(t.env, { role: 'owner', orgId: 'org_other', email: 'other@example.com' });
    expect(a.html).toContain('Hide from sidebar');

    expect((await post(t, app, a.headers, '/sidebar', { hidden: '1' })).status).toBe(303);
    expect(await getSetting(t.env, t.org.id, HIDDEN_SETTING, false)).toBe(true);
    const overviewHtml = await (await app.request('/app', { headers: a.headers }, t.env)).text();
    expect(overviewHtml).not.toContain('href="/app/welcome"');
    // The page still opens and offers the way back.
    const hidden = await (await app.request('/app/welcome', { headers: a.headers }, t.env)).text();
    expect(hidden).toContain('Finish setting up');
    expect(hidden).toContain('Show in sidebar');
    expect(await (await app.request('/app', { headers: b.headers }, t.env)).text()).toContain('href="/app/welcome"');

    await post(t, app, a.headers, '/sidebar', { hidden: '0' });
    expect(await (await app.request('/app', { headers: a.headers }, t.env)).text()).toContain('href="/app/welcome"');
    expect(t.sqlite.prepare("SELECT action FROM audit_log WHERE action LIKE 'onboarding.%' ORDER BY rowid").all()).toEqual([{ action: 'onboarding.hidden' }, { action: 'onboarding.shown' }]);
  });
});
