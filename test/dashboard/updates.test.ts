import { readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import { recordJobFailure, registerCoreJob } from '../../src/core/jobs';
import updates from '../../src/dashboard/updates';
import { compareMigrations, loadUpdatesPage, runningVersion } from '../../src/dashboard/updates/data';
import { migrations as shipped } from '../../src/generated/migrations';
import type { Role } from '../../src/env';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const app = createApp({ screens: { updates } });

registerCoreJob('updates.noop', async () => {});

afterEach(() => registerModules([]));

async function setup() {
  const t = createTestEnv();
  const owner = await createTestSession(t.env, { role: 'owner', instanceOwner: true, email: 'owner@example.com' });
  // A workspace owner who did not claim the install must not get in.
  const wsOwner = await createTestSession(t.env, { role: 'owner', email: 'ws-owner@example.com' });
  const roles = {} as Record<Exclude<Role, 'owner'>, TestSession>;
  for (const role of ['admin', 'member', 'viewer'] as const) roles[role] = await createTestSession(t.env, { role, email: `${role}@example.com` });
  return { t, owner, wsOwner, ...roles };
}

const get = (t: TestEnv, who: TestSession | null, path = '/app/updates') => app.request(path, { headers: who?.headers ?? {} }, t.env);

function post(t: TestEnv, who: TestSession, path: string, fields: Record<string, string> = {}) {
  return app.request(
    path,
    { method: 'POST', headers: { ...who.headers, 'content-type': 'application/x-www-form-urlencoded', origin: 'http://localhost' }, body: new URLSearchParams(fields).toString() },
    t.env,
  );
}

const flashOf = (res: Response) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ts_flash='))?.split(';')[0]?.slice('ts_flash='.length);
  return raw ? (JSON.parse(decodeURIComponent(decodeURIComponent(raw))) as { kind: string; message: string }) : null;
};

/** Wrangler's own bookkeeping table, which the test database does not have unless a test adds it. */
function addMigrationsTable(t: TestEnv, rows: [string, string][]) {
  t.sqlite.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const [name, at] of rows) t.sqlite.prepare('INSERT INTO d1_migrations (name, applied_at) VALUES (?, ?)').run(name, at);
}

async function fail(t: TestEnv, name: string, at: number, payload: unknown = { orgId: 'org_x', n: 1 }, error = 'boom') {
  const real = Date.now;
  Date.now = () => at;
  try {
    await recordJobFailure(t.env, { name, payload }, new Error(error), 5);
  } finally {
    Date.now = real;
  }
}

describe('who can open Updates', () => {
  it('lets the install owner in', async () => {
    const { t, owner } = await setup();
    const res = await get(t, owner);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('How to update');
  });

  it('refuses everyone else with the plain error page', async () => {
    const people = await setup();
    for (const who of [people.wsOwner, people.admin, people.member, people.viewer]) {
      const res = await get(people.t, who);
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Only the owner of this install can open Updates.');
    }
  });

  it('sends a signed-out visitor to sign in', async () => {
    const { t } = await setup();
    const res = await get(t, null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it('refuses a retry from anyone but the install owner, and changes nothing', async () => {
    const { t, admin, wsOwner } = await setup();
    await fail(t, 'core.nothing', 1_000);
    const id = (await t.env.DB.prepare('SELECT id FROM job_failures').first<string>('id'))!;
    for (const who of [admin, wsOwner]) {
      const res = await post(t, who, `/app/updates/jobs/${id}/retry`);
      expect(res.status).toBe(403);
    }
    expect(t.queue.sent).toHaveLength(0);
  });
});

describe('what the page reports', () => {
  it('shows the running version from package.json', async () => {
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    expect(runningVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(html).toContain(`Version ${runningVersion()}`);
  });

  it('lists the installed modules with their versions', async () => {
    registerModules([
      defineModule({ id: 'alpha', name: 'Alpha tool', description: 'x', icon: 'link', category: 'growth', version: '1.2.3' }),
      defineModule({ id: 'beta', name: 'Beta tool', description: 'x', icon: 'link', category: 'support', version: '0.4.0' }),
    ]);
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    expect(html).toContain('Alpha tool');
    expect(html).toContain('1.2.3');
    expect(html).toContain('Beta tool');
    expect(html).toContain('Modules installed');
  });

  it('says so when there are no modules', async () => {
    const { t, owner } = await setup();
    expect(await (await get(t, owner)).text()).toContain('No modules are installed');
  });

  it('says the list is not available when the database keeps no migrations table', async () => {
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    expect(html).toContain('This database does not keep a list');
    expect(html).toContain('Not available');
  });

  it('names the changes the code ships that the database does not have yet', async () => {
    const { t, owner } = await setup();
    expect(shipped.length).toBeGreaterThan(2);
    addMigrationsTable(t, shipped.slice(0, -2).map((name) => [name, '2026-11-20 09:30:00'] as [string, string]));
    const html = await (await get(t, owner)).text();
    expect(html).toContain('2 database changes are waiting');
    expect(html).toContain('2 waiting');
    for (const name of shipped.slice(-2)) expect(html).toContain(name);
    expect(html).toContain('>Waiting<');
    expect(html).toContain('href="#how-to-update"');
    expect(html).toContain('id="how-to-update"');
  });

  it('uses the singular for one waiting change', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, shipped.slice(0, -1).map((name) => [name, '2026-11-20 09:30:00'] as [string, string]));
    const html = await (await get(t, owner)).text();
    expect(html).toContain('1 database change is waiting');
    expect(html).toContain('until it is applied');
  });

  it('shows no notice when every shipped change is applied', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, shipped.map((name) => [name, '2026-11-20 09:30:00'] as [string, string]));
    const html = await (await get(t, owner)).text();
    expect(html).not.toContain('waiting');
    expect(html).not.toContain('does not know');
    expect(html).toContain(`${shipped.length} changes applied`);
  });

  it('explains a database that is ahead of the code, as after going back a version', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, [...shipped, 'core_9999_future.sql'].map((name) => [name, '2026-11-20 09:30:00'] as [string, string]));
    const html = await (await get(t, owner)).text();
    expect(html).toContain('The database has 1 change this version does not know');
    expect(html).toContain('core_9999_future.sql');
    expect(html).toContain('Newer version');
    expect(html).not.toContain('waiting');
  });

  it('calls nothing waiting when the database keeps no list', async () => {
    const { t } = await setup();
    const page = await loadUpdatesPage(t.env, { shipped: ['a.sql'] });
    expect(page.migrations).toBeNull();
    expect(page.waiting).toEqual([]);
    expect(page.unknown).toEqual([]);
  });

  it('shortens a long list of waiting changes', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, []);
    const html = await (await get(t, owner)).text();
    if (shipped.length > 4) expect(html).toContain(`and ${shipped.length - 4} more`);
    expect(html).toContain(`${shipped.length} database changes are waiting`);
  });

  it('lists applied database changes with the latest one in the summary', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, shipped.map((name, i) => [name, `2026-11-20 09:30:${String(i).padStart(2, '0')}`] as [string, string]));
    const html = await (await get(t, owner)).text();
    expect(html).toContain(`${shipped.length} changes applied`);
    expect(html).toContain(`latest ${shipped[shipped.length - 1]}`);
    expect(html).toContain('core_0001_core.sql');
    expect(html).toContain('Nov 20, 2026, 9:30 AM UTC');
  });

  it('lists every shipped change as waiting when the database has recorded none', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, []);
    const html = await (await get(t, owner)).text();
    expect(html).toContain('0 changes applied');
    expect(html).not.toContain('No database changes recorded yet');
    expect(html.split('>Waiting<').length - 1).toBe(shipped.length);
  });

  it('shows a change name from the database as text, never as markup', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, [...shipped.map((name) => [name, '2026-11-20 09:30:00'] as [string, string]), ['<img src=x onerror=alert(1)>.sql', '2026-11-21 09:30:00']]);
    const html = await (await get(t, owner)).text();
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('keeps the shipped list in the order Wrangler applies the files', () => {
    expect(shipped).toEqual(readdirSync('migrations').filter((f) => f.endsWith('.sql')).sort());
  });

  it('reports email as dev mode in the test environment and as needing setup in production', async () => {
    const dev = await setup();
    expect(await (await get(dev.t, dev.owner)).text()).toContain('Dev mode');
    const prod = createTestEnv({ ENVIRONMENT: 'production' });
    const owner = await createTestSession(prod.env, { role: 'owner', instanceOwner: true });
    const html = await (await get(prod, owner)).text();
    expect(html).toContain('Needs setup');
    expect(html).toContain('href="/app/email"');
  });

  it('does not offer an update button or call any outside address', async () => {
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    expect(html).not.toMatch(/Update now|Check now/);
    expect(html).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it('shows the update commands from the project', async () => {
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    for (const cmd of ['wrangler d1 migrations apply DB --remote', 'wrangler deploy', 'wrangler rollback', 'npm run prepare:app']) expect(html).toContain(cmd);
  });
});

describe('failed jobs', () => {
  it('shows an empty state when nothing failed', async () => {
    const { t, owner } = await setup();
    const html = await (await get(t, owner)).text();
    expect(html).toContain('No failed jobs');
  });

  it('lists failures newest first, with the error and what can be retried', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.older', 1_000, { orgId: 'org_x' }, 'older error');
    await fail(t, 'core.newer', 2_000, { orgId: 'org_x' }, 'newer error');
    await fail(t, 'core.private', 3_000, { orgId: 'org_x', blob: 'x'.repeat(9_000) }, 'too big');
    const html = await (await get(t, owner)).text();
    expect(html.indexOf('core.private')).toBeLessThan(html.indexOf('core.newer'));
    expect(html.indexOf('core.newer')).toBeLessThan(html.indexOf('core.older'));
    expect(html).toContain('newer error');
    expect(html).toContain('Can’t retry');
    expect(html).toContain('Retry job');
  });

  it('escapes markup and holds long and non-Latin text', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.<script>alert(1)</script>', 1_000, { orgId: 'org_x' }, `<script>alert("x")</script> ${'é'.repeat(300)} 日本語の失敗`);
    const html = await (await get(t, owner)).text();
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('日本語の失敗');
  });

  it('pages through failures with an Older link and Back to newest', async () => {
    const { t, owner } = await setup();
    for (let i = 1; i <= 30; i++) await fail(t, `core.job${String(i).padStart(2, '0')}`, i * 1_000);
    const first = await (await get(t, owner)).text();
    expect(first).toContain('core.job30');
    expect(first).not.toContain('core.job05<');
    const next = /href="(\/app\/updates\?before=\d+)#failed-jobs"/.exec(first)?.[1];
    expect(next).toBeTruthy();
    const second = await (await get(t, owner, next!)).text();
    expect(second).toContain('core.job05');
    expect(second).not.toContain('core.job30');
    expect(second).toContain('Back to newest');
    expect(second).not.toContain('rel="next"');
  });

  it('ignores a bad page marker instead of failing', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.one', 1_000);
    const res = await get(t, owner, '/app/updates?before=%27%3B--');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('core.one');
  });
});

describe('retrying a failed job', () => {
  it('puts it back on the queue, marks it retried and writes an audit entry', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.updates.noop', 1_000, { orgId: 'org_x', n: 7 });
    const id = (await t.env.DB.prepare('SELECT id FROM job_failures').first<string>('id'))!;
    const res = await post(t, owner, `/app/updates/jobs/${id}/retry`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/updates#failed-jobs');
    expect(flashOf(res)?.kind).toBe('ok');
    expect(t.queue.sent).toHaveLength(1);
    expect(t.queue.sent[0]?.body).toMatchObject({ name: 'core.updates.noop', payload: { orgId: 'org_x', n: 7 } });
    expect(await t.env.DB.prepare('SELECT retried_at FROM job_failures WHERE id = ?1').bind(id).first<number>('retried_at')).not.toBeNull();
    const audit = await t.env.DB.prepare("SELECT org_id, target_id, actor_label FROM audit_log WHERE action = 'updates.job_retried'").first<{ org_id: string | null; target_id: string; actor_label: string }>();
    expect(audit).toEqual({ org_id: null, target_id: id, actor_label: 'owner@example.com' });
  });

  it('keeps the page marker when sending the owner back', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.updates.noop', 1_000);
    const id = (await t.env.DB.prepare('SELECT id FROM job_failures').first<string>('id'))!;
    const res = await post(t, owner, `/app/updates/jobs/${id}/retry`, { before: '5000' });
    expect(res.headers.get('location')).toBe('/app/updates?before=5000#failed-jobs');
  });

  it('explains a job that is gone, without a crash or an audit entry', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/updates/jobs/jf_0000000000aaaaaaaaaaaa/retry');
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({ kind: 'error' });
    expect(await t.env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'updates.job_retried'").first<number>('n')).toBe(0);
  });

  it('explains a job whose details were not kept', async () => {
    const { t, owner } = await setup();
    await fail(t, 'core.updates.noop', 1_000, { orgId: 'org_x', blob: 'x'.repeat(9_000) });
    const id = (await t.env.DB.prepare('SELECT id FROM job_failures').first<string>('id'))!;
    const res = await post(t, owner, `/app/updates/jobs/${id}/retry`);
    expect(res.status).toBe(303);
    expect(flashOf(res)?.kind).toBe('error');
    expect(t.queue.sent).toHaveLength(0);
  });

  it('refuses a malformed id', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/updates/jobs/not-an-id/retry');
    expect(res.status).toBe(422);
  });

  it('refuses a post from another site', async () => {
    const { t, owner } = await setup();
    const res = await app.request(
      '/app/updates/jobs/jf_0000000000aaaaaaaaaaaa/retry',
      { method: 'POST', headers: { ...owner.headers, origin: 'https://evil.example.com' } },
      t.env,
    );
    expect(res.status).toBe(403);
  });
});

describe('compareMigrations', () => {
  it('keeps the shipped order for waiting changes', () => {
    expect(compareMigrations(['a.sql', 'b.sql', 'c.sql'], ['b.sql'])).toEqual({ waiting: ['a.sql', 'c.sql'], unknown: [] });
  });

  it('matches names with or without the .sql ending', () => {
    expect(compareMigrations(['a.sql', 'b.sql'], ['a', 'B.SQL'.toLowerCase()])).toEqual({ waiting: [], unknown: [] });
  });

  it('reports recorded changes the code does not ship', () => {
    expect(compareMigrations(['a.sql'], ['a.sql', 'z.sql'])).toEqual({ waiting: [], unknown: ['z.sql'] });
  });

  it('handles an empty database and empty code', () => {
    expect(compareMigrations(['a.sql'], [])).toEqual({ waiting: ['a.sql'], unknown: [] });
    expect(compareMigrations([], [])).toEqual({ waiting: [], unknown: [] });
  });
});
