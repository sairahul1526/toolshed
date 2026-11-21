import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import { cleanupExports, EXPORT_PAGE_ROWS, exportKey, getExport, listExports, planSources, R2Sink, requestExport, runExport } from '../../src/core/export';
import { MAX_JOB_ATTEMPTS, runJob, runSchedules } from '../../src/core/jobs';
import { listNotifications } from '../../src/core/notifications';
import exportRoutes from '../../src/core/routes/export';
import { createTestEnv, type TestEnv } from '../helpers/d1';
import { routeApp } from './helpers';
import { readZip } from './zipreader';

afterEach(() => registerModules([]));

const OTHER = 'org_other';

function notesModule(extra: Partial<Parameters<typeof defineModule>[0]> = {}) {
  return defineModule({
    id: 'notes', name: 'Notes', description: 'Notes', icon: 'file', category: 'growth', version: '0.1.0',
    tables: ['notes_items'],
    ...extra,
  });
}

function setup(vars: Record<string, string> = {}) {
  const t = createTestEnv(vars);
  registerModules([notesModule()]);
  t.sqlite.exec(`CREATE TABLE notes_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL, title TEXT, body TEXT, n INTEGER)`);
  return t;
}

function addNotes(t: TestEnv, org: string, count: number) {
  const stmt = t.sqlite.prepare('INSERT INTO notes_items (id, org_id, title, body, n) VALUES (?, ?, ?, ?, ?)');
  t.sqlite.exec('BEGIN');
  for (let i = 0; i < count; i++) stmt.run(`n_${org}_${String(i).padStart(5, '0')}`, org, `Note ${i}`, `Body ${i}`, i);
  t.sqlite.exec('COMMIT');
}

async function runToEnd(t: TestEnv, id: string) {
  await t.drainJobs();
  return (await getExport(t.env, t.org.id, id))!;
}

const ask = (t: TestEnv, over: Record<string, unknown> = {}) =>
  requestExport(t.env, { orgId: t.org.id, userId: 'usr_admin', email: 'admin@example.com', baseUrl: 'https://tools.example.com', ...over });

async function zipOf(t: TestEnv, id: string) {
  const obj = t.files.store.get(exportKey(t.org.id, id));
  expect(obj).toBeTruthy();
  return readZip(obj!.body);
}

describe('building the ZIP', () => {
  it('writes a JSON and a CSV per table, plus a manifest, and every CRC checks out', async () => {
    const t = setup();
    t.sqlite.prepare(`INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'appearance.accent', '"#2b5"', 1)`).run(t.org.id);
    t.sqlite.prepare(`INSERT INTO module_state (org_id, module_id, enabled) VALUES (?, 'notes', 1)`).run(t.org.id);
    t.sqlite.prepare(`INSERT INTO notes_items (id, org_id, title, body, n) VALUES ('n_1', ?, '=SUM(A1)', 'Line one, "quoted"\nLine two', 7)`).run(t.org.id);
    t.sqlite.prepare(`INSERT INTO notes_items (id, org_id, title, body, n) VALUES ('n_2', ?, 'Café 日本語', NULL, -3)`).run(t.org.id);

    const item = await ask(t);
    expect(item.status).toBe('queued');
    const done = await runToEnd(t, item.id);
    expect(done.status).toBe('done');
    expect(done.tablesDone).toBe(done.tablesTotal);
    expect(done.size).toBe(t.files.store.get(exportKey(t.org.id, item.id))!.body.length);
    expect(done.expiresAt! - done.completedAt!).toBe(24 * 3_600_000);

    const files = await zipOf(t, item.id);
    const names = files.map((f) => f.name);
    expect(names).toContain('json/core.settings.json');
    expect(names).toContain('csv/core.module_state.csv');
    expect(names).toContain('json/core.audit_log.json');
    expect(names).toContain('json/notes.notes_items.json');
    expect(names).toContain('csv/notes.notes_items.csv');
    expect(names.at(-1)).toBe('manifest.json');
    // Every table has both formats.
    for (const n of names.filter((x) => x.startsWith('json/'))) expect(names).toContain(n.replace('json/', 'csv/').replace(/\.json$/, '.csv'));

    const rows = JSON.parse(files.find((f) => f.name === 'json/notes.notes_items.json')!.text());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ id: 'n_1', org_id: t.org.id, title: '=SUM(A1)', body: 'Line one, "quoted"\nLine two', n: 7 });
    expect(rows[1].body).toBeNull();

    const csv = files.find((f) => f.name === 'csv/notes.notes_items.csv')!.text();
    expect(csv.startsWith('﻿id,org_id,title,body,n\r\n')).toBe(true);
    expect(csv).toContain(`n_1,${t.org.id},'=SUM(A1),"Line one, ""quoted""\nLine two",7\r\n`);
    expect(csv).toContain(`n_2,${t.org.id},Café 日本語,,-3\r\n`);

    const manifest = JSON.parse(files.find((f) => f.name === 'manifest.json')!.text());
    expect(manifest.tables.find((x: { name: string }) => x.name === 'notes.notes_items').rows).toBe(2);
    expect(manifest.workspace.id).toBe(t.org.id);
    expect(JSON.parse(files.find((f) => f.name === 'json/core.settings.json')!.text())).toEqual([{ key: 'appearance.accent', value: '"#2b5"', updated_at: 1 }]);
  });

  it('pages through big tables without dropping or repeating rows', async () => {
    const t = setup();
    const total = EXPORT_PAGE_ROWS * 2 + 37;
    addNotes(t, t.org.id, total);
    const item = await ask(t);
    await runToEnd(t, item.id);
    const files = await zipOf(t, item.id);
    const rows = JSON.parse(files.find((f) => f.name === 'json/notes.notes_items.json')!.text()) as { id: string }[];
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((r) => r.id)).size).toBe(total);
    const csv = files.find((f) => f.name === 'csv/notes.notes_items.csv')!.text();
    expect(csv.split('\r\n').length).toBe(total + 2); // header + rows + trailing empty
  });

  it('handles a table that is exactly one page, and an empty table', async () => {
    const t = setup();
    addNotes(t, t.org.id, EXPORT_PAGE_ROWS);
    const item = await ask(t);
    await runToEnd(t, item.id);
    const files = await zipOf(t, item.id);
    expect(JSON.parse(files.find((f) => f.name === 'json/notes.notes_items.json')!.text())).toHaveLength(EXPORT_PAGE_ROWS);
    expect(files.find((f) => f.name === 'json/core.settings.json')!.text()).toBe('[]\n');
    expect(files.find((f) => f.name === 'csv/core.settings.csv')!.text()).toBe('﻿key,value,updated_at\r\n');
  });

  it('never includes another workspace', async () => {
    const t = setup();
    addNotes(t, t.org.id, 3);
    addNotes(t, OTHER, 4);
    t.sqlite.prepare(`INSERT INTO settings (scope, key, value, updated_at) VALUES (?, 'secret.other', '"top"', 1)`).run(OTHER);
    t.sqlite.prepare(`INSERT INTO audit_log (id, org_id, action, created_at) VALUES ('a1', ?, 'other.did', 1)`).run(OTHER);
    t.sqlite.prepare(`INSERT INTO audit_log (id, org_id, action, created_at) VALUES ('a2', ?, 'mine.did', 1)`).run(t.org.id);
    const item = await ask(t);
    await runToEnd(t, item.id);
    const files = await zipOf(t, item.id);
    const all = files.map((f) => f.text()).join('\n');
    expect(all).not.toContain(OTHER);
    expect(all).not.toContain('other.did');
    expect(all).not.toContain('top');
    expect(all).toContain('mine.did');
    expect(JSON.parse(files.find((f) => f.name === 'json/notes.notes_items.json')!.text())).toHaveLength(3);
  });

  it('uses a module exportData when it has one', async () => {
    const t = createTestEnv();
    registerModules([notesModule({ exportData: async (ctx) => ({ summary: [{ org: ctx.org.id, total: 5 }], extra: [] }) })]);
    const item = await ask(t);
    await runToEnd(t, item.id);
    const files = await zipOf(t, item.id);
    expect(JSON.parse(files.find((f) => f.name === 'json/notes.summary.json')!.text())).toEqual([{ org: t.org.id, total: 5 }]);
    expect(files.find((f) => f.name === 'json/notes.extra.json')!.text()).toBe('[]\n');
  });

  it('leaves out secrets from API keys and adds people to members', async () => {
    const t = setup();
    const key = (id: string, org: string, name: string, prefix: string, hash: string, scopes: string) =>
      t.env.DB.prepare(
        "INSERT INTO api_keys (id, org_id, name, kind, prefix, key_hash, scopes, role, created_by, created_at) VALUES (?1, ?2, ?3, 'service', ?4, ?5, ?6, 'member', 'u_test', 5)",
      ).bind(id, org, name, prefix, hash, scopes).run();
    await key('k1', t.org.id, 'CI', 'ts_live_abcd1234', 'sha256:SECRET', '["*"]');
    await key('k2', OTHER, 'Nope', 'ts_live_zzzz9999', 'sha256:OTHERSECRET', '[]');
    t.sqlite.exec(`
      INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('${t.org.id}', 'Mine', 'mine-export', 1);
      INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES ('${OTHER}', 'Other', 'other-export', 1);
      INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES ('u1', 'Ana', 'ana@example.com', 1, 1, 1);
      INSERT INTO account (id, accountId, providerId, userId, password, createdAt, updatedAt) VALUES ('ac1', 'u1', 'credential', 'u1', 'pbkdf2:HASH', 1, 1);
      INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m1', '${t.org.id}', 'u1', 'admin', 1);
      INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m2', '${OTHER}', 'u1', 'member', 1);
    `);
    const item = await ask(t);
    await runToEnd(t, item.id);
    const files = await zipOf(t, item.id);
    const keys = JSON.parse(files.find((f) => f.name === 'json/core.api_keys.json')!.text());
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ id: 'k1', org_id: t.org.id, name: 'CI', prefix: 'ts_live_abcd1234', scopes: '["*"]', created_at: 5 });
    expect(keys[0]).not.toHaveProperty('key_hash');
    const members = JSON.parse(files.find((f) => f.name === 'json/core.members.json')!.text());
    expect(members).toHaveLength(1);
    expect(members[0]).toMatchObject({ id: 'm1', organizationId: t.org.id, userId: 'u1', role: 'admin', email: 'ana@example.com', name: 'Ana' });
    const text = files.map((f) => f.text()).join('\n');
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('HASH');
  });

  it('plans sources in a stable order, core first', async () => {
    const t = setup();
    const sources = await planSources(t.env, { ...t.org });
    expect(sources.map((s) => s.name)).toEqual(['core.settings', 'core.module_state', 'core.audit_log', 'core.api_keys', 'core.members', 'notes.notes_items']);
    expect(sources[5]!.columns).toEqual(['id', 'org_id', 'title', 'body', 'n']);
  });
});

describe('asking for an export', () => {
  it('allows one at a time and lists newest first', async () => {
    const t = setup();
    const first = await ask(t);
    await expect(ask(t)).rejects.toMatchObject({ code: 'export.already_running', status: 409 });
    await runToEnd(t, first.id);
    const second = await ask(t, { now: undefined });
    expect(second.id).not.toBe(first.id);
    expect((await listExports(t.env, t.org.id)).map((e) => e.id)).toEqual([second.id, first.id]);
    expect(await listExports(t.env, OTHER)).toEqual([]);
  });

  it('treats an export that never finished as stuck after half an hour', async () => {
    const t = setup();
    const old = Date.now() - 31 * 60_000;
    await requestExport(t.env, { orgId: t.org.id, userId: 'u', baseUrl: 'https://tools.example.com' }, old);
    await expect(ask(t)).resolves.toMatchObject({ status: 'queued' });
  });

  it('limits how many a workspace can start in an hour', async () => {
    const t = setup();
    for (let i = 0; i < 6; i++) {
      const item = await ask(t);
      await runToEnd(t, item.id);
    }
    await expect(ask(t)).rejects.toMatchObject({ code: 'rate_limited' });
  });
});

describe('telling the requester', () => {
  it('adds a notification and sends the ready email with the download link', async () => {
    const t = setup();
    const item = await ask(t);
    await runToEnd(t, item.id);
    const bell = await listNotifications(t.env, { orgId: t.org.id, userId: 'usr_admin' });
    expect(bell.items[0]).toMatchObject({ title: 'Your export is ready', href: `/api/v1/export/${item.id}/download` });
    const other = await listNotifications(t.env, { orgId: t.org.id, userId: 'usr_other', isAdmin: false });
    expect(other.items).toEqual([]);

    const log = t.sqlite.prepare(`SELECT to_addr, template, status, body_html FROM email_log WHERE template = 'export-ready'`).all() as { to_addr: string; template: string; status: string; body_html: string }[];
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ to_addr: 'admin@example.com', status: 'dev' });
    expect(log[0]!.body_html).toContain(`https://tools.example.com/api/v1/export/${item.id}/download`);
    expect(log[0]!.body_html).toContain('24 hours');
  });

  it('skips the email when there is no address, and still finishes when email breaks', async () => {
    const t = setup();
    const item = await ask(t, { email: null });
    await runToEnd(t, item.id);
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM email_log`).get()).toEqual({ n: 0 });

    const t2 = setup({ ENVIRONMENT: 'production' });
    t2.sqlite.prepare(`UPDATE exports SET status = status`).run();
    const item2 = await ask(t2);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await runToEnd(t2, item2.id);
    spy.mockRestore();
    expect((await getExport(t2.env, t2.org.id, item2.id))!.status).toBe('done');
  });

  it('does not send twice when the job runs again', async () => {
    const t = setup();
    const item = await ask(t);
    await runToEnd(t, item.id);
    await runExport(t.env, item.id);
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM email_log WHERE template = 'export-ready'`).get()).toEqual({ n: 1 });
  });
});

describe('failing and retrying', () => {
  it('cleans up, keeps the row retryable and marks it failed after the last attempt', async () => {
    const t = setup();
    const item = await ask(t);
    const realPut = t.files.put.bind(t.files);
    let broken = true;
    t.files.put = (async (...args: Parameters<typeof realPut>) => {
      if (broken) throw new Error('R2 is down');
      return realPut(...args);
    }) as typeof t.files.put;
    const msg = t.queue.sent.shift()!.body;

    await expect(runJob(t.env, msg, 1)).rejects.toThrow('R2 is down');
    expect((await getExport(t.env, t.org.id, item.id))!.status).toBe('running');
    expect(t.files.store.size).toBe(0);

    await expect(runJob(t.env, msg, MAX_JOB_ATTEMPTS)).rejects.toThrow('R2 is down');
    const failed = (await getExport(t.env, t.org.id, item.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('could not be built');
    expect(failed.error).not.toContain('R2');

    // A new request works after a failure.
    broken = false;
    const next = await ask(t);
    await runToEnd(t, next.id);
    expect((await getExport(t.env, t.org.id, next.id))!.status).toBe('done');
  });

  it('succeeds on a retry and ignores a job for an export that is already done or unknown', async () => {
    const t = setup();
    const item = await ask(t);
    const realPut = t.files.put.bind(t.files);
    let fails = 1;
    t.files.put = (async (...args: Parameters<typeof realPut>) => {
      if (fails-- > 0) throw new Error('blip');
      return realPut(...args);
    }) as typeof t.files.put;
    const msg = t.queue.sent.shift()!.body;
    await expect(runJob(t.env, msg, 1)).rejects.toThrow('blip');
    await runJob(t.env, msg, 2);
    expect((await getExport(t.env, t.org.id, item.id))!.status).toBe('done');
    await runJob(t.env, msg, 3); // done: nothing happens
    await runJob(t.env, { name: 'core.export', payload: { exportId: 'exp_missing' } });
    await runJob(t.env, { name: 'core.export', payload: {} });
  });
});

describe('R2Sink', () => {
  class FakeBucket {
    parts: number[] = [];
    done: Uint8Array | null = null;
    aborted = false;
    put = async () => {};
    delete = async () => {};
    private chunks: Uint8Array[] = [];
    createMultipartUpload = async () => {
      const self = this;
      return {
        uploadPart: async (n: number, bytes: Uint8Array) => {
          self.parts.push(bytes.length);
          self.chunks[n - 1] = bytes.slice();
          return { partNumber: n, etag: `e${n}` };
        },
        complete: async () => {
          const all = new Uint8Array(self.chunks.reduce((s, c) => s + c.length, 0));
          let at = 0;
          for (const c of self.chunks) {
            all.set(c, at);
            at += c.length;
          }
          self.done = all;
        },
        abort: async () => void (self.aborted = true),
      };
    };
  }

  it('uploads equal-sized parts and a short last part, and the bytes come back intact', async () => {
    const bucket = new FakeBucket();
    const sink = new R2Sink(bucket as unknown as R2Bucket, 'k', 100);
    const source = new Uint8Array(1_030).map((_, i) => (i * 7) & 255);
    for (let at = 0; at < source.length; at += 33) await sink.write(source.subarray(at, at + 33));
    await sink.close();
    expect(bucket.parts).toEqual([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 30]);
    expect(bucket.done).toEqual(source);
    expect(sink.size).toBe(1_030);
  });

  it('handles one chunk bigger than several parts', async () => {
    const bucket = new FakeBucket();
    const sink = new R2Sink(bucket as unknown as R2Bucket, 'k', 100);
    await sink.write(new Uint8Array(350).fill(9));
    await sink.close();
    expect(bucket.parts).toEqual([100, 100, 100, 50]);
  });

  it('uses a single put for small files and aborts on failure', async () => {
    const puts: [string, number][] = [];
    const bucket = { put: async (k: string, v: Uint8Array) => void puts.push([k, v.length]), createMultipartUpload: async () => { throw new Error('no'); } };
    const small = new R2Sink(bucket as unknown as R2Bucket, 'small.zip', 100);
    await small.write(new Uint8Array(40));
    await small.close();
    expect(puts).toEqual([['small.zip', 40]]);

    const fake = new FakeBucket();
    const sink = new R2Sink(fake as unknown as R2Bucket, 'k', 10);
    await sink.write(new Uint8Array(25));
    await sink.abort();
    expect(fake.aborted).toBe(true);
  });
});

describe('download routes', () => {
  async function ready() {
    const t = setup();
    addNotes(t, t.org.id, 2);
    const item = await ask(t);
    await runToEnd(t, item.id);
    return { t, item };
  }

  it('gives admins the ZIP with safe headers, and records it', async () => {
    const { t, item } = await ready();
    const api = routeApp(exportRoutes.api!, t, { role: 'admin' });
    const res = await api.request(`/${item.id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="test-export-\d{4}-\d{2}-\d{2}\.zip"$/);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Number(res.headers.get('content-length'))).toBe(bytes.length);
    expect(readZip(bytes).map((f) => f.name)).toContain('json/notes.notes_items.json');
    const log = t.sqlite.prepare(`SELECT action, target_id, actor_label FROM audit_log WHERE action = 'export.downloaded'`).all();
    expect(log).toEqual([{ action: 'export.downloaded', target_id: item.id, actor_label: 'admin@example.com' }]);
  });

  it('turns away members, viewers, people with no workspace and signed-out requests', async () => {
    const { t, item } = await ready();
    for (const role of ['member', 'viewer'] as const) {
      const res = await routeApp(exportRoutes.api!, t, { role }).json(`/${item.id}/download`);
      expect(res.status).toBe(403);
    }
    expect((await routeApp(exportRoutes.api!, t, { role: null }).json(`/${item.id}/download`)).status).toBe(401);
    for (const path of ['/', `/${item.id}`]) expect((await routeApp(exportRoutes.api!, t, { role: 'member' }).json(path)).status).toBe(403);
    const start = await routeApp(exportRoutes.api!, t, { role: 'member' }).json('/', { method: 'POST' });
    expect(start.status).toBe(403);
  });

  it('does not reveal another workspace export, even to an admin of that workspace', async () => {
    const { t, item } = await ready();
    const stranger = routeApp(exportRoutes.api!, t, { role: 'admin', orgId: OTHER });
    expect((await stranger.json(`/${item.id}/download`)).status).toBe(404);
    expect((await stranger.json(`/${item.id}`)).status).toBe(404);
    expect((await stranger.json('/')).body.items).toEqual([]);
  });

  it('refuses while it is still running, after it failed, and once it expired', async () => {
    const t = setup();
    const running = await ask(t);
    const api = routeApp(exportRoutes.api!, t, { role: 'admin' });
    expect(await api.json(`/${running.id}/download`)).toMatchObject({ status: 409, body: { code: 'export.not_ready' } });

    await runToEnd(t, running.id);
    t.sqlite.prepare(`UPDATE exports SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, running.id);
    expect(await api.json(`/${running.id}/download`)).toMatchObject({ status: 410, body: { code: 'export.expired' } });
    expect((await api.json(`/${running.id}`)).body.export.status).toBe('expired');
    expect((await api.json(`/${running.id}`)).body.export.downloadPath).toBeNull();

    const failedId = 'exp_failed';
    t.sqlite.prepare(`INSERT INTO exports (id, org_id, requested_by, status, created_at) VALUES (?, ?, 'u', 'failed', 1)`).run(failedId, t.org.id);
    expect(await api.json(`/${failedId}/download`)).toMatchObject({ status: 409, body: { code: 'export.failed' } });
    expect((await api.json('/missing/download')).status).toBe(404);
  });

  it('answers 410 when the file is gone even though the row says done', async () => {
    const { t, item } = await ready();
    t.files.store.delete(exportKey(t.org.id, item.id));
    const res = await routeApp(exportRoutes.api!, t, { role: 'admin' }).json(`/${item.id}/download`);
    expect(res.status).toBe(410);
  });

  it('starts an export from the API and reports progress', async () => {
    const t = setup();
    const api = routeApp(exportRoutes.api!, t, { role: 'admin', email: 'ana@example.com' });
    const started = await api.json('/', { method: 'POST' });
    expect(started.status).toBe(202);
    expect(started.body.export).toMatchObject({ status: 'queued', downloadPath: null });
    expect((await api.json('/', { method: 'POST' })).body.code).toBe('export.already_running');
    await t.drainJobs();
    const one = await api.json(`/${started.body.export.id}`);
    expect(one.body.export).toMatchObject({ status: 'done', downloadPath: `/api/v1/export/${started.body.export.id}/download` });
    expect((await api.json('/')).body.items).toHaveLength(1);
    const audit = t.sqlite.prepare(`SELECT actor_label FROM audit_log WHERE action = 'export.requested'`).all();
    expect(audit).toEqual([{ actor_label: 'ana@example.com' }]);
    // The email goes to the person, not to the address in the request.
    expect((t.sqlite.prepare(`SELECT to_addr FROM email_log WHERE template = 'export-ready'`).get() as { to_addr: string }).to_addr).toBe('ana@example.com');
  });

  it('does not email API keys', async () => {
    const t = setup();
    const api = routeApp(exportRoutes.api!, t, { role: 'admin', kind: 'apikey' });
    expect((await api.json('/', { method: 'POST' })).status).toBe(202);
    await t.drainJobs();
    expect(t.sqlite.prepare(`SELECT COUNT(*) AS n FROM email_log`).get()).toEqual({ n: 0 });
  });
});

describe('expiry', () => {
  it('deletes files after 24 hours, keeps fresh ones, and the daily schedule runs it', async () => {
    const t = setup();
    const old = await ask(t);
    await runToEnd(t, old.id);
    const fresh = await ask(t);
    await runToEnd(t, fresh.id);
    t.sqlite.prepare(`UPDATE exports SET expires_at = ? WHERE id = ?`).run(Date.now() - 5_000, old.id);

    expect(await cleanupExports(t.env)).toBe(1);
    expect(t.files.store.has(exportKey(t.org.id, old.id))).toBe(false);
    expect(t.files.store.has(exportKey(t.org.id, fresh.id))).toBe(true);
    expect((await getExport(t.env, t.org.id, old.id))!.status).toBe('expired');
    expect((await getExport(t.env, t.org.id, fresh.id))!.status).toBe('done');

    t.sqlite.prepare(`UPDATE exports SET expires_at = ? WHERE id = ?`).run(Date.now() - 5_000, fresh.id);
    const out = await runSchedules(t.env, new Date(Date.UTC(2026, 10, 22, 0, 0)));
    expect(out.ran).toContain('core.export-cleanup');
    expect(t.files.store.size).toBe(0);
  });

  it('marks long-stuck exports failed and forgets old finished rows', async () => {
    const t = setup();
    const now = Date.now();
    const insert = t.sqlite.prepare(`INSERT INTO exports (id, org_id, requested_by, status, created_at) VALUES (?, ?, 'u', ?, ?)`);
    insert.run('exp_stuck', t.org.id, 'running', now - 3 * 3_600_000);
    insert.run('exp_old_failed', t.org.id, 'failed', now - 100 * 86_400_000);
    insert.run('exp_recent_failed', t.org.id, 'failed', now - 86_400_000);
    await cleanupExports(t.env, now);
    expect((await getExport(t.env, t.org.id, 'exp_stuck'))!.status).toBe('failed');
    expect(await getExport(t.env, t.org.id, 'exp_old_failed')).toBeNull();
    expect(await getExport(t.env, t.org.id, 'exp_recent_failed')).not.toBeNull();
  });
});
