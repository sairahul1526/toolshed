import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { mountModule } from '../../../test/helpers/app';
import { setModuleEnabled } from '../../core/registry';
import links from './module';

async function setup(opts: Parameters<typeof mountModule>[2] = {}) {
  const t = createTestEnv();
  const app = await mountModule(t, links, opts);
  return { t, app };
}

const json = async (res: Response) => (await res.json()) as any;

describe('links API', () => {
  it('creates, reads, edits, archives, duplicates and deletes a link', async () => {
    const { app } = await setup();
    const made = await app.request('/api/v1/links', { json: { url: 'https://example.com/a', title: 'A', tags: ['Blog'] } });
    expect(made.status).toBe(201);
    const link = await json(made);
    expect(link.code).toMatch(/^[a-z0-9]{7}$/);
    expect(link.tags).toEqual(['blog']);
    expect(link.shortUrl).toBe(`http://localhost/${link.code}`);

    const edited = await json(await app.request(`/api/v1/links/${link.id}`, { method: 'PATCH', json: { url: 'https://example.com/b', notes: 'hi' } }));
    expect(edited.url).toBe('https://example.com/b');
    expect(edited.code).toBe(link.code);

    const archived = await json(await app.request(`/api/v1/links/${link.code}/archive`, { method: 'POST' }));
    expect(archived.status).toBe('archived');
    const gone = await json(await app.request('/api/v1/links'));
    expect(gone.items).toHaveLength(0);
    const restored = await json(await app.request(`/api/v1/links/${link.id}/restore`, { method: 'POST' }));
    expect(restored.status).toBe('active');

    const copy = await app.request(`/api/v1/links/${link.id}/duplicate`, { method: 'POST' });
    expect(copy.status).toBe(201);
    expect((await json(copy)).code).not.toBe(link.code);

    expect((await app.request(`/api/v1/links/${link.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await app.request(`/api/v1/links/${link.id}`)).status).toBe(404);
  });

  it('refuses taken, reserved and bad codes and bad destinations', async () => {
    const { app } = await setup();
    await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'promo' } });
    const taken = await app.request('/api/v1/links', { json: { url: 'https://example.com/x', code: 'Promo' } });
    expect(taken.status).toBe(409);
    expect((await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'api' } })).status).toBeGreaterThanOrEqual(400);
    expect((await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'a b' } })).status).toBe(422);
    for (const bad of ['javascript:alert(1)', 'ftp://example.com', 'not a url', 'https://']) {
      const res = await app.request('/api/v1/links', { json: { url: bad } });
      expect(res.status, bad).toBe(422);
    }
  });

  it('bulk creates up to 100 and reports the failures by position', async () => {
    const { app } = await setup();
    const res = await app.request('/api/v1/links/bulk', { json: { links: [{ url: 'https://example.com/1' }, { url: 'nope' }, { url: 'https://example.com/3', code: 'three' }] } });
    const body = await json(res);
    expect(body.created).toHaveLength(2);
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].index).toBe(1);
    const tooMany = await app.request('/api/v1/links/bulk', { json: { links: Array.from({ length: 101 }, (_, i) => ({ url: `https://example.com/${i}` })) } });
    expect(tooMany.status).toBe(413);
  });

  it('searches, filters, sorts and pages', async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) await app.request('/api/v1/links', { json: { url: `https://example.com/p${i}`, title: `Page ${i}`, tags: i % 2 ? ['odd'] : ['even'] } });
    expect((await json(await app.request('/api/v1/links?q=Page%203'))).items).toHaveLength(1);
    expect((await json(await app.request('/api/v1/links?tag=odd'))).items).toHaveLength(2);
    const first = await json(await app.request('/api/v1/links?limit=2&sort=title'));
    expect(first.items.map((l: any) => l.title)).toEqual(['Page 0', 'Page 1']);
    expect(first.nextCursor).toBeTruthy();
    const second = await json(await app.request(`/api/v1/links?limit=2&sort=title&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect(second.items.map((l: any) => l.title)).toEqual(['Page 2', 'Page 3']);
  });

  it('runs bulk actions and skips ids from other workspaces', async () => {
    const { app } = await setup();
    const a = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com/a' } }));
    const b = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com/b' } }));
    const tagged = await json(await app.request('/api/v1/links/actions', { json: { ids: [a.id, b.id, 'lnk_other'], action: 'tag', tag: 'promo' } }));
    expect(tagged).toEqual({ done: 2, skipped: 1 });
    expect((await json(await app.request('/api/v1/links?tag=promo'))).items).toHaveLength(2);
    await app.request('/api/v1/links/actions', { json: { ids: [a.id], action: 'archive' } });
    expect((await json(await app.request('/api/v1/links'))).items).toHaveLength(1);
    await app.request('/api/v1/links/actions', { json: { ids: [b.id], action: 'delete' } });
    expect((await app.request(`/api/v1/links/${b.id}`)).status).toBe(404);
  });

  it('manages folders and tags', async () => {
    const { app } = await setup();
    const folder = await json(await app.request('/api/v1/links/folders', { json: { name: 'Launch' } }));
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com', folderId: folder.id, tags: ['x'] } }));
    expect(link.folderId).toBe(folder.id);
    expect((await json(await app.request(`/api/v1/links?folder=${folder.id}`))).items).toHaveLength(1);
    expect((await json(await app.request('/api/v1/links/tags'))).items).toEqual([{ tag: 'x', links: 1 }]);
    const renamed = await json(await app.request(`/api/v1/links/folders/${folder.id}`, { method: 'PATCH', json: { name: 'Launch 2' } }));
    expect(renamed.name).toBe('Launch 2');
    await app.request(`/api/v1/links/folders/${folder.id}`, { method: 'DELETE' });
    expect((await json(await app.request(`/api/v1/links/${link.id}`))).folderId).toBeNull();
  });

  it('keeps people from other workspaces out', async () => {
    const { t, app } = await setup();
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com/private' } }));
    t.org.id = 'org_other';
    await setModuleEnabled(t.env, 'org_other', 'links', true);
    expect((await app.request(`/api/v1/links/${link.id}`)).status).toBe(404);
    expect((await json(await app.request('/api/v1/links'))).items).toHaveLength(0);
    expect((await app.request(`/api/v1/links/${link.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('lets viewers and read keys read but not change', async () => {
    const { app } = await setup();
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com' } }));
    for (const caller of [app.as({ role: 'viewer' }), app.as({ kind: 'apikey', scopes: ['links:read'] })]) {
      expect((await caller.request('/api/v1/links')).status).toBe(200);
      expect((await caller.request(`/api/v1/links/${link.id}/stats`)).status).toBe(200);
      expect((await caller.request('/api/v1/links', { json: { url: 'https://example.com/z' } })).status).toBe(403);
      expect((await caller.request(`/api/v1/links/${link.id}`, { method: 'DELETE' })).status).toBe(403);
    }
    expect((await app.as({ kind: 'apikey', scopes: ['links:write'] }).request('/api/v1/links', { json: { url: 'https://example.com/ok' } })).status).toBe(201);
    expect((await app.as({ kind: 'apikey', scopes: ['forms:read'] }).request('/api/v1/links')).status).toBe(403);
    expect((await app.as({ kind: 'anon' }).request('/api/v1/links')).status).toBe(401);
  });

  it('answers 404 while the module is off', async () => {
    const { app } = await setup({ off: true });
    expect((await app.request('/api/v1/links')).status).toBe(404);
  });

  it('writes audit entries and emits events', async () => {
    const { t, app } = await setup();
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'audited' } }));
    await app.request(`/api/v1/links/${link.id}`, { method: 'PATCH', json: { title: 'T' } });
    await app.request(`/api/v1/links/${link.id}`, { method: 'DELETE' });
    const actions = t.sqlite.prepare('SELECT action FROM audit_log ORDER BY created_at, rowid').all().map((r: any) => r.action);
    expect(actions).toEqual(['links.link.created', 'links.link.updated', 'links.link.deleted']);
    const names = t.sqlite.prepare(`SELECT name FROM event_counts WHERE module = 'links' ORDER BY name`).all().map((r: any) => r.name);
    expect(names).toEqual(expect.arrayContaining(['link.created', 'link.updated', 'link.deleted']));
  });

  it('rate limits creation', async () => {
    const { app } = await setup();
    let last = 201;
    for (let i = 0; i < 125 && last === 201; i++) last = (await app.request('/api/v1/links', { json: { url: `https://example.com/${i}` } })).status;
    expect(last).toBe(429);
  });

  it('blocks destination domains and switches off links already there', async () => {
    const { app } = await setup();
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://bad.example.net/x' } }));
    const res = await json(await app.request('/api/v1/links/blocklist', { json: { domain: 'https://Example.net/' } }));
    expect(res.domain.domain).toBe('example.net');
    expect(res.disabledLinks).toBe(1);
    expect((await json(await app.request(`/api/v1/links/${link.id}`))).state).toBe('disabled');
    expect((await app.request('/api/v1/links', { json: { url: 'https://sub.example.net/' } })).status).toBe(422);
    await app.request(`/api/v1/links/blocklist/${res.domain.id}`, { method: 'DELETE' });
    expect((await app.request('/api/v1/links', { json: { url: 'https://sub.example.net/' } })).status).toBe(201);
  });

  it('imports a CSV with a mapping and reports skipped rows', async () => {
    const { app } = await setup();
    const csv = 'Long URL,Back-half,Title\nhttps://example.com/a,alpha,Alpha\nnot a url,,Bad\nhttps://example.com/b,alpha,Dup\n';
    const preview = await json(await app.request('/api/v1/links/import/preview', { json: { csv } }));
    expect(preview.rowCount).toBe(3);
    expect(preview.mapping.url).toBe(0);
    const done = await json(await app.request('/api/v1/links/import', { json: { csv, mapping: preview.mapping } }));
    expect(done.created).toBe(1);
    expect(done.skipped.map((s: any) => s.row)).toEqual([3, 4]);
    expect((await app.request('/api/v1/links/alpha')).status).toBe(200);
  });

  it('exports links and clicks as CSV and neutralises formulas', async () => {
    const { app } = await setup();
    await app.request('/api/v1/links', { json: { url: 'https://example.com/e', title: '=SUM(1,2)', code: 'exp' } });
    const res = await app.request('/api/v1/links/export/links.csv');
    expect(res.headers.get('content-type')).toContain('text/csv');
    const text = await res.text();
    expect(text).toContain('exp');
    expect(text).not.toContain(',=SUM');
    expect((await app.request('/api/v1/links/export/clicks.csv')).status).toBe(200);
    expect((await app.request('/api/v1/links/export/daily.csv?days=7')).status).toBe(200);
  });

  it('reads and saves settings', async () => {
    const { app } = await setup();
    expect((await json(await app.request('/api/v1/links/settings'))).defaultRedirectType).toBe(302);
    await app.request('/api/v1/links/settings', { method: 'PATCH', json: { defaultRedirectType: 301, codeLength: 9 } });
    const link = await json(await app.request('/api/v1/links', { json: { url: 'https://example.com' } }));
    expect(link.redirectType).toBe(301);
    expect(link.code).toHaveLength(9);
  });

  it('shares one namespace between links and bio pages', async () => {
    const { app } = await setup();
    await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'sam' } });
    expect((await app.request('/api/v1/links/bios', { json: { code: 'sam', name: 'x' } })).status).toBe(409);
    expect((await app.request('/api/v1/links/bios', { json: { code: 'mine', name: 'x' } })).status).toBe(201);
    expect((await app.request('/api/v1/links', { json: { url: 'https://example.com', code: 'mine' } })).status).toBe(409);
  });
});
