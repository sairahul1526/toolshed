import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import { recordJobFailure, registerCoreJob } from '../../src/core/jobs';
import updates from '../../src/dashboard/updates';
import { runningVersion } from '../../src/dashboard/updates/data';
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

  it('lists applied database changes with the latest one in the summary', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, [
      ['core_0001_core.sql', '2026-11-20 09:30:00'],
      ['core_0002_auth.sql', '2026-11-20 09:30:01'],
    ]);
    const html = await (await get(t, owner)).text();
    expect(html).toContain('2 changes applied');
    expect(html).toContain('latest core_0002_auth.sql');
    expect(html).toContain('core_0001_core.sql');
    expect(html).toContain('Nov 20, 2026, 9:30 AM UTC');
  });

  it('shows an empty list of applied changes with the next step', async () => {
    const { t, owner } = await setup();
    addMigrationsTable(t, []);
    expect(await (await get(t, owner)).text()).toContain('No database changes recorded yet');
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
