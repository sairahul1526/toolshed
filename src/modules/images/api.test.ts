import { describe, expect, it } from 'vitest';
import { mountModule } from '../../../test/helpers/app';
import { orgDb } from '../../core/db';
import { createBatch } from './batch';
import images from './module';
import { blankDoc } from './schema';
import { saveSettings } from './settings';
import { createTemplate } from './templates';
import { blogTemplate, imagesTestEnv, mounted, pathOf, tinyPng, type Mounted } from './test-support';

const API = '/api/v1/images';

interface Json {
  [key: string]: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

async function json(res: Response, status = 200): Promise<Json> {
  const body = (await res.json()) as Json;
  expect({ status: res.status, code: body.code }).toEqual({ status, code: undefined });
  return body;
}

async function refused(res: Response, status: number, code: string): Promise<Json> {
  const body = (await res.json()) as Json;
  expect({ status: res.status, code: body.code }).toEqual({ status, code });
  return body;
}

function audit(m: Mounted): string[] {
  return (m.t.sqlite.prepare('SELECT action FROM audit_log ORDER BY rowid').all() as { action: string }[]).map((row) => row.action);
}

describe('who may call the API', () => {
  it('asks a visitor to sign in', async () => {
    const m = await mounted();
    expect((await m.visitor.request(`${API}/templates`)).status).toBe(401);
    expect((await m.visitor.request(`${API}/render`, { json: { template: 'x' } })).status).toBe(401);
  });

  it('is not there while the module is off', async () => {
    const t = await imagesTestEnv();
    const app = await mountModule(t, images, { off: true });
    await refused(await app.request(`${API}/templates`), 404, 'module_off');
    await refused(await app.request(`${API}/templates`, { json: { starter: 'blog' } }), 404, 'module_off');
  });

  it('lets a viewer look but not change anything', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const viewer = m.app.as({ role: 'viewer' });
    expect((await json(await viewer.request(`${API}/templates`))).items).toHaveLength(1);
    await json(await viewer.request(`${API}/usage`));
    await json(await viewer.request(`${API}/settings`));
    await refused(await viewer.request(`${API}/templates`, { json: { starter: 'blog' } }), 403, 'forbidden');
    await refused(await viewer.request(`${API}/templates/${template.id}`, { method: 'DELETE' }), 403, 'forbidden');
    await refused(await viewer.request(`${API}/render`, { json: { template: template.id } }), 403, 'forbidden');
    await refused(await viewer.request(`${API}/assets?name=a.png`, { method: 'POST', body: tinyPng() }), 403, 'forbidden');
    await refused(await viewer.request(`${API}/settings`, { method: 'PUT', json: { dailyCap: 5 } }), 403, 'forbidden');
  });

  it('holds an API key to its scopes', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const reader = m.app.as({ kind: 'apikey', scopes: ['images:read'] });
    await json(await reader.request(`${API}/templates/${template.id}`));
    await json(await reader.request(`${API}/templates/${template.id}/preview`, { json: { values: { title: 'Hi' } } }));
    await refused(await reader.request(`${API}/render`, { json: { template: template.id } }), 403, 'forbidden');
    await refused(await reader.request(`${API}/templates/${template.id}/url`, { json: {} }), 403, 'forbidden');

    const writer = m.app.as({ kind: 'apikey', scopes: ['images:read', 'images:write'] });
    await json(await writer.request(`${API}/render`, { json: { template: template.id } }), 201);

    const none = m.app.as({ kind: 'apikey', scopes: ['forms:read'] });
    await refused(await none.request(`${API}/templates`), 403, 'forbidden');
    const token = m.app.as({ kind: 'jwt', scopes: ['images:read'] });
    await json(await token.request(`${API}/templates`));
    await refused(await token.request(`${API}/templates`, { json: { starter: 'blog' } }), 403, 'forbidden');
  });

  it('blocks a signed-in change that comes from another site', async () => {
    const m = await mounted();
    await refused(await m.app.request(`${API}/templates`, { json: { starter: 'blog' }, headers: { origin: 'https://elsewhere.example.com' } }), 403, 'forbidden');
  });

  it('never shows one workspace another’s templates, uploads, batches or numbers', async () => {
    const m = await mounted();
    const other = orgDb(m.t.env.DB, 'org_other');
    const theirs = await createTemplate(m.t.env, other, { starter: 'blog', publish: true });
    const batch = await createBatch(m.t.env, other, { templateId: theirs.id, rows: [{ title: 'Theirs' }] }, 'http://localhost');
    await m.t.drainJobs();

    expect((await json(await m.app.request(`${API}/templates`))).items).toEqual([]);
    expect((await json(await m.app.request(`${API}/batches`))).items).toEqual([]);
    expect((await json(await m.app.request(`${API}/log`))).items).toEqual([]);
    expect((await json(await m.app.request(`${API}/usage`))).totals.renders).toBe(0);
    await refused(await m.app.request(`${API}/templates/${theirs.id}`), 404, 'not_found');
    await refused(await m.app.request(`${API}/templates/${theirs.id}`, { method: 'PATCH', json: { name: 'Mine now' } }), 404, 'not_found');
    await refused(await m.app.request(`${API}/templates/${theirs.id}`, { method: 'DELETE' }), 404, 'not_found');
    await refused(await m.app.request(`${API}/templates/${theirs.id}/export`), 404, 'not_found');
    await refused(await m.app.request(`${API}/render`, { json: { template: theirs.id } }), 404, 'not_found');
    await refused(await m.app.request(`${API}/batches`, { json: { templateId: theirs.id, rows: [{ title: 'x' }] } }), 404, 'not_found');
    await refused(await m.app.request(`${API}/batches/${batch.id}`), 404, 'not_found');
    await refused(await m.app.request(`${API}/batches/${batch.id}/download.zip`), 404, 'not_found');
  });
});

describe('templates over the API', () => {
  it('goes from a starter to a published template with an image URL', async () => {
    const m = await mounted();
    const created = await json(await m.app.request(`${API}/templates`, { json: { starter: 'blog' } }), 201);
    const id = created.template.id as string;
    expect(created.template).toMatchObject({ name: 'Blog post', published: false, version: 0, width: 1200, height: 630 });

    const list = await json(await m.app.request(`${API}/templates?limit=10`));
    expect(list.nextCursor).toBeNull();
    expect(list.items[0].doc).toBeUndefined();

    await refused(await m.app.request(`${API}/templates/${id}/url`, { json: {} }), 404, 'images.not_published');

    const renamed = await json(await m.app.request(`${API}/templates/${id}`, { method: 'PATCH', json: { name: 'Launch notes', slug: 'launch-notes' } }));
    expect(renamed.template).toMatchObject({ name: 'Launch notes', slug: 'launch-notes' });

    const broken = { ...blankDoc(600, 300), background: 'red' };
    const invalid = await refused(await m.app.request(`${API}/templates/${id}`, { method: 'PATCH', json: { doc: broken } }), 422, 'validation_failed');
    expect(Object.keys(invalid.fields)).toEqual(['background']);

    const published = await json(await m.app.request(`${API}/templates/${id}/publish`, { method: 'POST' }));
    expect(published.template).toMatchObject({ published: true, version: 1, unpublishedChanges: false });

    const link = await json(await m.app.request(`${API}/templates/${id}/url`, { json: { values: { title: 'Hello there' } } }));
    expect(link).toMatchObject({ format: 'svg', width: 1200, height: 630, signed: true, expiresAt: null });
    expect(link.url).toMatch(/^http:\/\/localhost\/i\/launch-notes\.svg\?title=Hello\+there&sig=/);
    expect(link.metaTags).toContain('<meta property="og:image" content="http://localhost/i/launch-notes.svg?title=Hello+there&amp;sig=');
    const image = await m.visitor.request(pathOf(link.url));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');

    expect(audit(m)).toEqual(['images.template.created', 'images.template.settings_changed', 'images.template.published']);
  });

  it('refuses a template it cannot make, with a reason per field', async () => {
    const m = await mounted();
    const tooBig = await refused(await m.app.request(`${API}/templates`, { json: { width: 99999, height: 10 } }), 422, 'validation_failed');
    expect(Object.keys(tooBig.fields).sort()).toEqual(['height', 'width']);
    await refused(await m.app.request(`${API}/templates`, { json: { starter: 'nope' } }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/templates`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } }), 400, 'bad_request');
  });

  it('previews a draft, or a design that has not been saved, without storing anything', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const saved = await json(await m.app.request(`${API}/templates/${template.id}/preview`, { json: { values: { title: 'Preview me' }, width: 600 } }));
    expect(saved.svg).toMatch(/^<svg xmlns="http:\/\/www.w3.org\/2000\/svg" width="600" height="315"/);
    expect(saved.warnings).toEqual([]);
    const unsaved = await json(await m.app.request(`${API}/templates/${template.id}/preview`, { json: { doc: blankDoc(400, 200) } }));
    expect(unsaved.svg).toContain('width="400" height="200"');
    await refused(await m.app.request(`${API}/templates/${template.id}/preview`, { json: { doc: { v: 1 } } }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/templates/${template.id}/preview`, { json: { values: 'title' } }), 422, 'validation_failed');
    expect(m.t.files.store.size).toBe(0);
    expect((await json(await m.app.request(`${API}/usage`))).today).toBe(0);
  });

  it('exports a template as a file and imports it again', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const res = await m.app.request(`${API}/templates/${template.id}/export`);
    expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${template.slug}.template.json"`);
    const file = await json(res);
    expect(file).toMatchObject({ kind: 'toolshed.images.template', v: 1, name: 'Blog post' });

    const imported = await json(await m.app.request(`${API}/templates/import`, { json: file }), 201);
    expect(imported.template.id).not.toBe(template.id);
    expect(imported.template.doc).toEqual(template.doc);
    expect(imported.template.published).toBe(false);
    await refused(await m.app.request(`${API}/templates/import`, { json: { kind: 'something.else', doc: {} } }), 422, 'images.bad_template');
  });

  it('duplicates, reverts, clears and deletes', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const copy = await json(await m.app.request(`${API}/templates/${template.id}/duplicate`, { method: 'POST' }), 201);
    expect(copy.template).toMatchObject({ name: 'Blog post copy', published: false });

    await json(await m.app.request(`${API}/templates/${template.id}`, { method: 'PATCH', json: { doc: blankDoc(1200, 630) } }));
    const reverted = await json(await m.app.request(`${API}/templates/${template.id}/revert`, { method: 'POST' }));
    expect(reverted.template.doc).toEqual(template.doc);

    expect(await json(await m.app.request(`${API}/templates/${template.id}/clear`, { method: 'POST' }), 202)).toEqual({ cleared: true });
    expect(await json(await m.app.request(`${API}/templates/${template.id}`, { method: 'DELETE' }))).toEqual({ deleted: true });
    await refused(await m.app.request(`${API}/templates/${template.id}`), 404, 'not_found');
    expect(m.t.queue.sent.map((job) => (job.body as { payload: { keepBaked: boolean } }).payload.keepBaked)).toEqual([true, false]);
    expect(audit(m)).toEqual(['images.template.cache_cleared', 'images.template.deleted']);
  });

  it('lists the starters, sizes and fonts to choose from', async () => {
    const m = await mounted();
    const starters = await json(await m.app.request(`${API}/starters`));
    expect(starters.items.map((s: Json) => s.key)).toContain('blog');
    expect(starters.presets.map((p: Json) => p.id)).toEqual(['og', 'x', 'linkedin', 'instagram-square', 'instagram-story', 'youtube']);
    const fonts = await json(await m.app.request(`${API}/fonts`));
    expect(fonts.items.map((f: Json) => f.id)).toEqual(expect.arrayContaining(['inter', 'jetbrains-mono', 'libre-baskerville']));
    expect(fonts.items.find((f: Json) => f.id === 'inter').weights).toEqual([400, 600, 800]);
  });
});

describe('making images over the API', () => {
  it('draws an image once and hands back the same URL after that', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const body = { template: template.id, values: { title: 'From a script' }, width: 600 };
    const first = await json(await m.app.request(`${API}/render`, { json: body }), 201);
    expect(first.image).toMatchObject({ format: 'svg', width: 600, height: 315, cached: false });
    const second = await json(await m.app.request(`${API}/render`, { json: body }));
    expect(second.image).toMatchObject({ url: first.image.url, cached: true });
    const served = await m.visitor.request(pathOf(first.image.url));
    expect(served.headers.get('x-images-cache')).toBe('hit');
    expect(served.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('says what is wrong with a request it cannot draw', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await refused(await m.app.request(`${API}/render`, { json: {} }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/render`, { json: { template: template.id, format: 'jpg' } }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/render`, { json: { template: template.id, width: '600' } }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/render`, { json: { template: template.id, values: ['a'] } }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/render`, { json: { template: template.id, format: 'png' } }), 409, 'images.server_png_off');
    await saveSettings(m.t.env, m.t.org.id, { dailyCap: 0 });
    await refused(await m.app.request(`${API}/render`, { json: { template: template.id } }), 429, 'images.daily_cap');
  });

  it('stores a PNG drawn by the caller under the image URL', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const png = tinyPng(600, 315);
    const path = `${API}/templates/${template.id}/bake?title=Baked+here&w=600`;
    const baked = await json(await m.app.request(path, { method: 'POST', body: png, headers: { 'content-type': 'image/png' } }), 201);
    expect(baked.image).toMatchObject({ format: 'png', width: 600, height: 315, bytes: png.byteLength, cached: false });
    expect(baked.image.url).toContain('.png?title=Baked+here&w=600&v=1&sig=');

    const served = await m.visitor.request(pathOf(baked.image.url));
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(png);

    await json(await m.app.request(path, { method: 'POST', body: png }), 200);
    await refused(await m.app.request(path, { method: 'POST', body: tinyPng(10, 10) }), 422, 'images.bad_png');
    await refused(await m.app.request(path, { method: 'POST', body: png, headers: { 'content-length': String(6 * 1024 * 1024) } }), 413, 'too_large');
  });
});

describe('uploads over the API', () => {
  it('takes a file as the request body or as a form, and serves it to anyone', async () => {
    const m = await mounted();
    const raw = await json(await m.app.request(`${API}/assets?name=logo.png`, { method: 'POST', body: tinyPng(40, 20), headers: { 'content-type': 'image/png' } }), 201);
    expect(raw.asset).toMatchObject({ kind: 'image', name: 'logo.png', width: 40, height: 20 });

    const form = new FormData();
    form.set('file', new File([tinyPng(30, 30)], 'badge.png', { type: 'image/png' }));
    const viaForm = await json(await m.app.request(`${API}/assets`, { method: 'POST', body: form }), 201);
    expect(viaForm.asset).toMatchObject({ name: 'badge.png', width: 30 });

    const list = await json(await m.app.request(`${API}/assets?kind=image`));
    expect(list.items.map((a: Json) => a.name).sort()).toEqual(['badge.png', 'logo.png']);
    expect((await json(await m.app.request(`${API}/assets?kind=font`))).items).toEqual([]);
    expect((await json(await m.app.request(`${API}/assets/${raw.asset.id}`))).asset.id).toBe(raw.asset.id);

    expect((await m.visitor.request(raw.asset.path)).status).toBe(200);
    const mine = await m.app.request(`${API}/picture?src=${encodeURIComponent(raw.asset.ref)}`);
    expect(mine.status).toBe(200);
    expect(mine.headers.get('content-type')).toBe('image/png');

    expect(await json(await m.app.request(`${API}/assets/${raw.asset.id}`, { method: 'DELETE' }))).toEqual({ deleted: true });
    expect((await m.visitor.request(raw.asset.path)).status).toBe(404);
    await refused(await m.app.request(`${API}/assets/${raw.asset.id}`), 404, 'not_found');
    expect(audit(m)).toEqual(['images.asset.uploaded', 'images.asset.uploaded', 'images.asset.deleted']);
  });

  it('refuses a file it cannot use and a form without one', async () => {
    const m = await mounted();
    await refused(await m.app.request(`${API}/assets`, { method: 'POST', body: 'just some text, not a picture at all' }), 415, 'images.unsupported_file');
    const empty = new FormData();
    empty.set('note', 'no file here');
    await refused(await m.app.request(`${API}/assets`, { method: 'POST', body: empty }), 422, 'validation_failed');
    await refused(await m.app.request(`${API}/assets`, { method: 'POST', body: tinyPng(), headers: { 'content-length': String(9 * 1024 * 1024) } }), 413, 'too_large');
  });

  it('only loads outside pictures from sites the workspace allowed', async () => {
    const m = await mounted();
    await refused(await m.app.request(`${API}/picture?src=${encodeURIComponent('https://cdn.example.com/a.png')}`), 400, 'images.image_host_not_allowed');
    await refused(await m.app.request(`${API}/picture?src=${encodeURIComponent('http://127.0.0.1/a.png')}`), 400, 'images.image_host_not_allowed');
    await refused(await m.app.request(`${API}/picture`), 400, 'images.image_host_not_allowed');
    await refused(await m.app.request(`${API}/picture?src=asset:imga_missing`), 404, 'not_found');
  });
});

describe('batches over the API', () => {
  it('starts a batch, reports progress, and hands back the results as CSV and ZIP', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const started = await json(await m.app.request(`${API}/batches`, { json: { templateId: template.id, rows: [{ title: 'One' }, { title: 'Two' }] } }), 202);
    const id = started.batch.id as string;
    expect(started.batch).toMatchObject({ status: 'queued', total: 2 });
    await refused(await m.app.request(`${API}/batches/${id}/download.zip`), 409, 'images.batch_running');
    await refused(await m.app.request(`${API}/batches/${id}`, { method: 'DELETE' }), 409, 'images.batch_running');

    await m.t.drainJobs();
    const done = await json(await m.app.request(`${API}/batches/${id}`));
    expect(done.batch).toMatchObject({ status: 'done', done: 2, failed: 0 });
    expect((await json(await m.app.request(`${API}/batches`))).items).toHaveLength(1);

    const csv = await m.app.request(`${API}/batches/${id}/results.csv`);
    expect(csv.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect((await csv.text()).trim().split(/\r?\n/)).toHaveLength(3);

    const zip = await m.app.request(`${API}/batches/${id}/download.zip`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    expect(zip.headers.get('content-disposition')).toBe(`attachment; filename="${id}.zip"`);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    expect([...bytes.slice(0, 2)]).toEqual([0x50, 0x4b]);
    expect(new TextDecoder('latin1').decode(bytes)).toContain('002.svg');

    expect(await json(await m.app.request(`${API}/batches/${id}`, { method: 'DELETE' }))).toEqual({ deleted: true });
    expect(audit(m)).toContain('images.batch.started');
  });

  it('refuses a batch that is empty or too long', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await refused(await m.app.request(`${API}/batches`, { json: { templateId: template.id, rows: [] } }), 422, 'images.batch_empty');
    const rows = Array.from({ length: 101 }, (_, i) => ({ title: `Row ${i}` }));
    await refused(await m.app.request(`${API}/batches`, { json: { templateId: template.id, rows } }), 413, 'images.batch_too_large');
  });
});

describe('usage and settings over the API', () => {
  it('reports what was made, in UTC days, with real zeros', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const empty = await json(await m.app.request(`${API}/usage?days=7`));
    expect(empty).toMatchObject({ totals: { renders: 0, hits: 0, errors: 0, bytes: 0 }, today: 0, dailyCap: 1000, top: [], timezone: 'UTC' });
    expect(empty.days).toHaveLength(7);

    const made = await json(await m.app.request(`${API}/render`, { json: { template: template.id } }), 201);
    await m.visitor.request(pathOf(made.image.url));
    const usage = await json(await m.app.request(`${API}/usage?days=7&template=${template.id}`));
    expect(usage.totals).toMatchObject({ renders: 1, hits: 1 });
    expect(usage.today).toBe(1);
    expect(usage.top).toHaveLength(1);

    const log = await json(await m.app.request(`${API}/log?limit=5`));
    expect(log.items).toHaveLength(1);
    expect(log.items[0]).toMatchObject({ outcome: 'rendered', source: 'api', format: 'svg' });
    expect(log.nextCursor).toBeNull();
    expect((await json(await m.app.request(`${API}/log?errors=1`))).items).toEqual([]);
  });

  it('lets an admin change the settings, and nobody below', async () => {
    const m = await mounted();
    expect((await json(await m.app.request(`${API}/settings`))).settings).toEqual({ serverPng: false, dailyCap: 1000, allowedHosts: [] });
    const member = m.app.as({ role: 'member' });
    await refused(await member.request(`${API}/settings`, { method: 'PUT', json: { dailyCap: 5 } }), 403, 'forbidden');

    const saved = await json(await m.app.request(`${API}/settings`, { method: 'PUT', json: { dailyCap: 50, allowedHosts: ['CDN.Example.com', 'cdn.example.com'] } }));
    expect(saved.settings).toEqual({ serverPng: false, dailyCap: 50, allowedHosts: ['cdn.example.com'] });
    const invalid = await refused(await m.app.request(`${API}/settings`, { method: 'PUT', json: { dailyCap: -1, allowedHosts: ['https://cdn.example.com/x'] } }), 422, 'validation_failed');
    expect(Object.keys(invalid.fields).sort()).toEqual(['allowedHosts.0', 'dailyCap']);
    expect(audit(m)).toEqual(['images.settings.changed']);
  });
});
