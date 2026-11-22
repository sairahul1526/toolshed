import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newId } from '../../src/core/db';
import { registerModules } from '../../src/core/registry';
import type { Role } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import type { TestEnv } from '../helpers/d1';
import { auditRows, BASE, flashOf, impersonate, makeApp, newEnv, postInit, useLinks } from './settings-helpers';

let t: TestEnv;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  t = newEnv();
  useLinks();
  app = makeApp();
});
afterEach(() => registerModules([]));

const get = (headers: Record<string, string>, path = BASE) => app.request(path, { headers }, t.env);
const post = (headers: Record<string, string>, path: string, fields: Record<string, string | string[]> = {}) => app.request(path, postInit(headers, fields), t.env);
const org = () => t.env.DB.prepare('SELECT "name", "slug" FROM "organization" WHERE "id" = ?1').bind('org_test').first<{ name: string; slug: string }>();

async function insertExport(status: string, orgId = 'org_test', extra: Partial<{ size: number; completed: number; expires: number }> = {}): Promise<string> {
  const id = newId('exp');
  const now = Date.now();
  await t.env.DB.prepare(
    `INSERT INTO exports (id, org_id, requested_by, base_url, status, created_at, completed_at, expires_at, size) VALUES (?1, ?2, 'usr_x', 'http://localhost', ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, orgId, status, now - 60_000, status === 'done' ? (extra.completed ?? now - 30_000) : null, status === 'done' ? (extra.expires ?? now + 3_600_000) : null, extra.size ?? null)
    .run();
  return id;
}

describe('who can open it', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const res = await app.request(BASE, {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it.each(['owner', 'admin'] as const)('lets a %s save changes and shows every tab', async (role) => {
    const { headers } = await createTestSession(t.env, { role });
    const html = await (await get(headers)).text();
    expect(html).toContain('Settings');
    expect(html).toContain('Webhooks');
    expect(html).toContain('Data');
    expect(html).toContain('>Save<');
    expect(html).not.toContain('You can look, not change');
  });

  it.each(['member', 'viewer'] as const)('shows a %s the name read-only and refuses every post', async (role: Role) => {
    const { headers } = await createTestSession(t.env, { role });
    const html = await (await get(headers)).text();
    expect(html).toContain('You can look, not change');
    expect(html).not.toContain('>Save<');
    expect((await post(headers, `${BASE}/general`, { name: 'Nope', slug: 'nope' })).status).toBe(403);
    expect((await post(headers, `${BASE}/export`)).status).toBe(403);
    expect((await post(headers, `${BASE}/delete`, { confirm: 'test' })).status).toBe(403);
    expect((await post(headers, `${BASE}/webhooks`, { name: 'x', url: 'https://hooks.example.com/in', events: '*' })).status).toBe(403);
    expect((await get(headers, `${BASE}/webhooks/new`)).status).toBe(403);
    expect(await org()).toEqual({ name: 'Test Workspace', slug: 'test' });
    const data = await (await get(headers, `${BASE}?tab=data`)).text();
    expect(data).toContain('Admins only');
    expect(data).toContain('Owners only');
    const hooks = await (await get(headers, `${BASE}?tab=webhooks`)).text();
    expect(hooks).toContain('Admins only');
  });

  it('treats an unknown tab as the first one', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await get(headers, `${BASE}?tab=nonsense`)).text();
    expect(html).toContain('name="slug"');
  });
});

describe('General: name and address', () => {
  it('renames the workspace, writes the audit entry and shows the new name', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: 'Acme Tools', slug: 'acme' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(BASE);
    expect(flashOf(res)?.message).toContain('saved');
    expect(await org()).toEqual({ name: 'Acme Tools', slug: 'acme' });
    const rows = await auditRows(t, 'workspace.%');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('workspace.renamed');
    const html = await (await get(headers)).text();
    expect(html).toContain('value="Acme Tools"');
    expect(html).toContain('value="acme"');
  });

  it('says so, and writes nothing, when nothing changed', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: 'Test Workspace', slug: 'test' });
    expect(res.status).toBe(303);
    expect(flashOf(res)?.message).toContain('Nothing changed');
    expect(await auditRows(t, 'workspace.%')).toHaveLength(0);
  });

  it('keeps what was typed and explains an empty name', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: '   ', slug: 'fine-one' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('value="fine-one"');
    expect(html).toMatch(/error|name/i);
    expect(await org()).toEqual({ name: 'Test Workspace', slug: 'test' });
  });

  it('refuses a 300 character name and keeps the input', async () => {
    const { headers } = await createTestSession(t.env);
    const long = 'n'.repeat(300);
    const res = await post(headers, `${BASE}/general`, { name: long, slug: 'test' });
    expect(res.status).toBe(422);
    expect((await res.text()).includes(long)).toBe(true);
    expect((await org())!.name).toBe('Test Workspace');
  });

  it('refuses a bad address with a message under the field', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: 'Acme', slug: 'Not Valid!!' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('value="Not Valid!!"');
    expect((await org())!.slug).toBe('test');
  });

  it('says when the address belongs to another workspace', async () => {
    await createTestSession(t.env, { orgId: 'org_other' });
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: 'Acme', slug: 'org-other' });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/taken|already/i);
    expect((await org())!.slug).toBe('test');
  });

  it('escapes markup in a name', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/general`, { name: '<script>alert(1)</script>', slug: 'test' });
    const html = await (res.status === 303 ? await get(headers) : res).text();
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('lets an owner who is signed in as someone else rename, and records who did it', async () => {
    const { headers, sessionId } = await createTestSession(t.env, { role: 'admin' });
    const ownerId = await impersonate(t, sessionId);
    const res = await post(headers, `${BASE}/general`, { name: 'Renamed', slug: 'test' });
    expect(res.status).toBe(303);
    expect((await org())!.name).toBe('Renamed');
    expect((await auditRows(t, 'workspace.renamed'))[0]!.meta).toContain(ownerId);
  });
});

describe('Data: export', () => {
  it('starts an export, queues the job and writes the audit entry', async () => {
    const { headers, user } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/export`);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${BASE}?tab=data`);
    expect(flashOf(res)?.kind).toBe('ok');
    const rows = (await t.env.DB.prepare(`SELECT status, requested_by, requested_email FROM exports WHERE org_id = 'org_test'`).all<{ status: string; requested_by: string; requested_email: string }>()).results;
    expect(rows).toEqual([{ status: 'queued', requested_by: user.id, requested_email: user.email }]);
    expect(await auditRows(t, 'export.requested')).toHaveLength(1);
  });

  it('explains a second request while one is running instead of failing', async () => {
    const { headers } = await createTestSession(t.env);
    await post(headers, `${BASE}/export`);
    const again = await post(headers, `${BASE}/export`);
    expect(again.status).toBe(303);
    expect(flashOf(again)).toMatchObject({ kind: 'error', message: expect.stringContaining('already running') });
    const count = await t.env.DB.prepare(`SELECT COUNT(*) AS n FROM exports WHERE org_id = 'org_test'`).first<{ n: number }>();
    expect(count!.n).toBe(1);
    const html = await (await get(headers, `${BASE}?tab=data`)).text();
    expect(html).toContain('Waiting');
    expect(html).toContain('Check again');
  });

  it('shows an empty state, then lists past exports with a download link only for a finished one', async () => {
    const { headers } = await createTestSession(t.env);
    expect(await (await get(headers, `${BASE}?tab=data`)).text()).toContain('No exports yet');
    const done = await insertExport('done', 'org_test', { size: 2048 });
    await insertExport('failed');
    await insertExport('expired');
    const html = await (await get(headers, `${BASE}?tab=data`)).text();
    expect(html).toContain('Ready');
    expect(html).toContain('Failed');
    expect(html).toContain('Expired');
    expect(html).toContain(`href="/api/v1/export/${done}/download"`);
    expect(html.match(/\/api\/v1\/export\/[^"]+\/download/g)).toHaveLength(1);
    expect(html).toContain('2 KB');
  });

  it('never shows another workspace’s exports', async () => {
    const { headers } = await createTestSession(t.env);
    await createTestSession(t.env, { orgId: 'org_other' });
    const other = await insertExport('done', 'org_other');
    const html = await (await get(headers, `${BASE}?tab=data`)).text();
    expect(html).not.toContain(other);
    expect(html).toContain('No exports yet');
  });

  it('refuses an export while signed in as someone else', async () => {
    const { headers, sessionId } = await createTestSession(t.env);
    await impersonate(t, sessionId);
    const res = await post(headers, `${BASE}/export`);
    expect(res.status).toBe(303);
    expect(flashOf(res)?.kind).toBe('error');
    const count = await t.env.DB.prepare('SELECT COUNT(*) AS n FROM exports').first<{ n: number }>();
    expect(count!.n).toBe(0);
    expect(await (await get(headers, `${BASE}?tab=data`)).text()).toContain('Not while signed in as someone else');
  });
});

describe('Data: delete the workspace', () => {
  it('refuses an admin', async () => {
    const { headers } = await createTestSession(t.env, { role: 'admin' });
    expect((await post(headers, `${BASE}/delete`, { confirm: 'test' })).status).toBe(403);
    expect(await org()).not.toBeNull();
  });

  it('asks the owner to type the address and keeps what they typed when it is wrong', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await get(headers, `${BASE}?tab=data`)).text();
    expect(html).toContain('Type test to confirm');
    const res = await post(headers, `${BASE}/delete`, { confirm: 'wrong' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Type test to confirm.');
    expect(await org()).not.toBeNull();
  });

  it('deletes the workspace once the address is typed, and writes an install-wide line', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, `${BASE}/delete`, { confirm: 'test' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app');
    expect(await org()).toBeNull();
    const rows = await auditRows(t, 'workspace.deleted', null);
    expect(rows).toHaveLength(1);
  });

  it('asks for a fresh sign-in when the session is old', async () => {
    const { headers, sessionId } = await createTestSession(t.env);
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString();
    await t.env.DB.prepare('UPDATE "session" SET "createdAt" = ?1 WHERE "id" = ?2').bind(old, sessionId).run();
    const res = await post(headers, `${BASE}/delete`, { confirm: 'test' });
    expect([409, 403]).toContain(res.status);
    expect(await org()).not.toBeNull();
  });

  it('is refused while signed in as someone else', async () => {
    const { headers, sessionId } = await createTestSession(t.env);
    await impersonate(t, sessionId);
    const res = await post(headers, `${BASE}/delete`, { confirm: 'test' });
    expect(res.status).toBe(303);
    expect(flashOf(res)?.kind).toBe('error');
    expect(await org()).not.toBeNull();
  });
});
