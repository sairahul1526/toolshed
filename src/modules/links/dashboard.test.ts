import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import links from './module';

async function setup() {
  const t = createTestEnv();
  const app = await mountModule(t, links);
  return { t, app };
}

const html = (res: Response) => res.text();
const post = (app: MountedModule, path: string, form: Record<string, string> = {}) => app.request(path, { method: 'POST', form, redirect: 'manual' });
const make = async (app: MountedModule, body: Record<string, unknown> = {}) =>
  (await (await app.request('/api/v1/links', { json: { url: 'https://example.com/page', ...body } })).json()) as any;

describe('links dashboard', () => {
  it('shows the one-box first run when there are no links, then the ready card after shortening', async () => {
    const { app } = await setup();
    const first = await html(await app.request('/app/links'));
    expect(first).toContain('Shorten your first link');
    expect(first).toContain('name="url"');
    expect(first).toContain('/m/links/links.css');

    const res = await post(app, '/app/links', { url: 'https://example.com/long/page' });
    expect(res.status).toBe(303);
    const where = res.headers.get('location')!;
    expect(where).toMatch(/^\/app\/links\?made=[a-z0-9]+$/);
    const ready = await html(await app.request(where));
    expect(ready).toContain('Your short link is ready');
    expect(ready).toContain('data-qr-png');
    expect(ready).toContain('/l/qr/');
  });

  it('tells the person when the address is not accepted', async () => {
    const { app } = await setup();
    const res = await post(app, '/app/links', { url: 'javascript:alert(1)' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/links');
    expect(res.headers.get('set-cookie')).toContain('ts_flash');
  });

  it('lists links with search, status filter and an empty-result state', async () => {
    const { app } = await setup();
    await make(app, { title: 'Spring sale', code: 'spring' });
    await make(app, { title: 'Guides', code: 'guides', tags: ['help'] });
    const all = await html(await app.request('/app/links'));
    expect(all).toContain('Spring sale');
    expect(all).toContain('Guides');
    const found = await html(await app.request('/app/links?q=spring'));
    expect(found).toContain('Spring sale');
    expect(found).not.toContain('>Guides<');
    expect(await html(await app.request('/app/links?tag=help'))).toContain('Guides');
    const none = await html(await app.request('/app/links?q=zzzzzz'));
    expect(none).toContain('No links match');
    expect(none).toContain('Clear filters');
  });

  it('edits a link: rules, schedule, password, preview and utm', async () => {
    const { app } = await setup();
    const link = await make(app, { code: 'edit1' });
    const page = await html(await app.request(`/app/links/${link.id}`));
    expect(page).toContain('Save changes');
    expect(page).toContain('QR code');
    const res = await post(app, `/app/links/${link.id}`, {
      url: 'https://example.com/new', code: 'edit1', title: 'Edited', redirectType: '301', tags: 'a, b', password: 'hunter22',
      previewTitle: 'Look', expiresAt: '2099-01-01T10:00', clickCap: '5', utmSource: 'news', utmMedium: 'email',
      rule_kind_0: 'country', rule_values_0: 'in, us', rule_url_0: 'https://example.com/in',
    });
    expect(res.status).toBe(303);
    const saved = (await (await app.request(`/api/v1/links/${link.id}`)).json()) as any;
    expect(saved.title).toBe('Edited');
    expect(saved.redirectType).toBe(301);
    expect(saved.tags).toEqual(['a', 'b']);
    expect(saved.hasPassword).toBe(true);
    expect(saved.clickCap).toBe(5);
    expect(saved.preview.title).toBe('Look');
    expect(saved.url).toContain('utm_source=news');
    expect(saved.rules).toEqual([{ kind: 'country', values: ['IN', 'US'], url: 'https://example.com/in' }]);
    const again = await html(await app.request(`/app/links/${link.id}`));
    expect(again).toContain('Remove the password');
    expect(again).toContain('value="IN, US"');
  });

  it('shows the form again with field errors when a save is refused', async () => {
    const { app } = await setup();
    await make(app, { code: 'taken1' });
    const other = await make(app, { code: 'other1' });
    const res = await post(app, `/app/links/${other.id}`, { url: 'https://example.com/x', code: 'taken1', title: 'Keep me' });
    expect(res.status).toBe(422);
    const body = await html(res);
    expect(body).toContain('Some fields need fixing');
    expect(body).toContain('value="Keep me"');
    expect(body).toContain('already in use');
  });

  it('creates from the full form, and archives, restores, duplicates and deletes', async () => {
    const { app } = await setup();
    expect(await html(await app.request('/app/links/new'))).toContain('Create link');
    const created = await post(app, '/app/links/new', { url: 'https://example.com/full', code: 'full1', tags: 'x' });
    expect(created.status).toBe(303);
    const bad = await post(app, '/app/links/new', { url: 'ftp://example.com' });
    expect(bad.status).toBe(422);
    const link = (await (await app.request('/api/v1/links/full1')).json()) as any;
    await post(app, `/app/links/${link.id}/archive`);
    expect(((await (await app.request('/api/v1/links/full1')).json()) as any).status).toBe('archived');
    expect(await html(await app.request('/app/links?status=archived'))).toContain('Restore');
    await post(app, `/app/links/${link.id}/restore`);
    const dup = await post(app, `/app/links/${link.id}/duplicate`);
    expect(dup.status).toBe(303);
    expect(((await (await app.request('/api/v1/links')).json()) as any).items).toHaveLength(2);
    await post(app, `/app/links/${link.id}/delete`);
    expect((await app.request('/api/v1/links/full1')).status).toBe(404);
  });

  it('runs bulk actions and exports the selected links', async () => {
    const { app } = await setup();
    const a = await make(app, { code: 'bulka' });
    const b = await make(app, { code: 'bulkb' });
    const send = (action: string, extra: Record<string, string> = {}) => {
      const body = new URLSearchParams({ action, back: '/app/links', ...extra });
      body.append('ids', a.id);
      body.append('ids', b.id);
      return app.request('/app/links/bulk', { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
    };
    expect((await send('tag', { tag: 'promo' })).status).toBe(303);
    expect(((await (await app.request('/api/v1/links/bulka')).json()) as any).tags).toEqual(['promo']);
    const csv = await send('export');
    expect(csv.headers.get('content-type')).toContain('text/csv');
    expect(await csv.text()).toContain('bulkb');
    await send('archive');
    expect(((await (await app.request('/api/v1/links')).json()) as any).items).toHaveLength(0);
    expect((await post(app, '/app/links/bulk', { action: 'archive' })).headers.get('location')).toBe('/app/links');
    await send('delete');
    expect((await app.request('/api/v1/links/bulka')).status).toBe(404);
  });

  it('shows stats with zeros for empty days and a quiet state', async () => {
    const { app } = await setup();
    const link = await make(app, { code: 'stat1' });
    const quiet = await html(await app.request('/app/links/stats'));
    expect(quiet).toContain('No clicks in this range yet');
    await app.as({ kind: 'anon' }).request('/stat1', { headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605 Safari/604' } });
    const one = await html(await app.request(`/app/links/stats?link=${link.id}&days=7`));
    expect(one).toContain('Stats for /stat1');
    expect(one).toContain('Referrers');
    expect((await app.request('/app/links/stats?days=bogus')).status).toBe(200);
  });

  it('builds a bio page: profile, blocks, order, colours and removal', async () => {
    const { app } = await setup();
    const res = await post(app, '/app/links/bio', { name: 'Maya', code: 'maya' });
    expect(res.status).toBe(303);
    const bio = (await (await app.request('/api/v1/links/bios/maya')).json()) as any;
    expect(await html(await app.request(`/app/links/bio/${bio.id}`))).toContain('No blocks yet');
    await post(app, `/app/links/bio/${bio.id}/blocks`, { kind: 'link', title: 'Shop', url: 'https://example.com/shop' });
    await post(app, `/app/links/bio/${bio.id}/blocks`, { kind: 'heading', title: 'Follow' });
    let current = (await (await app.request('/api/v1/links/bios/maya')).json()) as any;
    expect(current.blocks.map((b: any) => b.visible)).toEqual([true, true]);
    expect(current.blocks.map((b: any) => b.title)).toEqual(['Shop', 'Follow']);
    await post(app, `/app/links/bio/blocks/${current.blocks[1].id}/move?dir=up`);
    current = (await (await app.request('/api/v1/links/bios/maya')).json()) as any;
    expect(current.blocks.map((b: any) => b.title)).toEqual(['Follow', 'Shop']);
    await post(app, `/app/links/bio/blocks/${current.blocks[0].id}`, { kind: 'heading', title: 'Find me', visible: 'on' });
    await post(app, `/app/links/bio/${bio.id}`, { name: 'Maya R', published: 'on', theme: 'custom', color_background: '#112233', color_text: '#ffffff', color_accent: '#ff8800', color_buttonText: '#000000' });
    current = (await (await app.request('/api/v1/links/bios/maya')).json()) as any;
    expect(current.name).toBe('Maya R');
    expect(current.published).toBe(true);
    expect(current.colors.background).toBe('#112233');
    expect(current.blocks[0].title).toBe('Find me');
    expect(await html(await app.request('/app/links/bio'))).toContain('Maya R');
    await post(app, `/app/links/bio/blocks/${current.blocks[0].id}/delete`);
    await post(app, `/app/links/bio/${bio.id}/delete`);
    expect((await app.request('/api/v1/links/bios/maya')).status).toBe(404);
  });

  it('imports a CSV in two steps and reports skipped rows', async () => {
    const { app } = await setup();
    const csv = 'long_url,title\nhttps://example.com/one,One\nnot a url,Bad\nhttps://example.com/two,Two\n';
    const upload = new FormData();
    upload.set('file', new File([csv], 'links.csv', { type: 'text/csv' }));
    const step = await app.request('/app/links/import', { method: 'POST', body: upload });
    const stepHtml = await html(step);
    expect(stepHtml).toContain('Check the columns');
    expect(stepHtml).toContain('3 rows found');
    const run = await post(app, '/app/links/import/run', { csv, map_url: '0', map_title: '1', map_code: '', map_short: '', map_tags: '', map_notes: '', map_expires: '' });
    const done = await html(run);
    expect(done).toContain('2 links created, 1 skipped');
    expect(done).toContain('Skipped rows');
    const skipped = await post(app, '/app/links/import/skipped', { rows: JSON.stringify([{ row: 3, reason: 'Bad address', url: 'not a url' }]) });
    expect(await skipped.text()).toContain('Bad address');
    expect((await post(app, '/app/links/import', {})).status).toBe(303);
    for (const kind of ['links', 'daily', 'clicks']) {
      const out = await app.request(`/app/links/export/${kind}.csv`);
      expect(out.headers.get('content-disposition')).toContain('.csv');
    }
  });

  it('manages settings, folders, blocked domains and reports', async () => {
    const { app } = await setup();
    const bad = await make(app, { url: 'https://spam.example.net/x', code: 'bad1' });
    expect(await html(await app.request('/app/links/settings'))).toContain('No reports');
    await post(app, '/app/links/settings', { defaultRedirectType: '301', codeLength: '9' });
    expect(((await (await app.request('/api/v1/links/settings')).json()) as any).codeLength).toBe(9);
    await post(app, '/app/links/settings/folders', { name: 'Press' });
    const folders = (await (await app.request('/api/v1/links/folders')).json()) as any;
    const list = folders.items ?? folders;
    expect(list[0].name).toBe('Press');
    await post(app, `/app/links/settings/folders/${list[0].id}`, { name: 'Media' });
    await post(app, '/app/links/settings/blocklist', { domain: 'spam.example.net' });
    expect(((await (await app.request('/api/v1/links/bad1')).json()) as any).status).toBe('disabled');
    const page = await html(await app.request('/app/links/settings'));
    expect(page).toContain('spam.example.net');
    expect(page).toContain('Media');
    expect(page).toContain('Custom domains are not part of this version');
    const visitor = app.as({ kind: 'anon' });
    await visitor.request('/l/report/bad1');
    void bad;
  });

  it('keeps viewers read-only and emits no inline scripts or styles', async () => {
    const { app } = await setup();
    const link = await make(app, { code: 'ro1' });
    const viewer = app.as({ role: 'viewer' });
    expect((await viewer.request('/app/links')).status).toBe(200);
    expect((await post(viewer, '/app/links', { url: 'https://example.com' })).status).toBe(403);
    expect((await post(viewer, `/app/links/${link.id}/delete`)).status).toBe(403);
    expect((await post(viewer, '/app/links/settings/blocklist', { domain: 'example.org' })).status).toBe(403);
    for (const path of ['/app/links', `/app/links/${link.id}`, '/app/links/stats', '/app/links/bio', '/app/links/import', '/app/links/settings', '/app/links/new']) {
      const body = await html(await app.request(path));
      expect(body, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
      expect(body, path).not.toMatch(/\sstyle="/);
      expect(body, path).not.toMatch(/\son[a-z]+="/);
    }
  });
});
