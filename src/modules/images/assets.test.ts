import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { orgDb } from '../../core/db';
import { setModuleEnabled } from '../../core/registry';
import { deleteAsset, getAsset, listAssets, MAX_ASSETS, publicAsset, uploadAsset } from './assets';
import { blankDoc, type TemplateDoc } from './schema';
import { previewSvg } from './serve';
import { mounted, tinyPng } from './test-support';

const FONT = 'public/m/images/fonts/jetbrains-mono/jetbrains-mono-500-latin.ttf';

/** A one-line design whose text uses the given font family. */
function titleIn(font: string | undefined): TemplateDoc {
  return {
    v: 1,
    width: 600,
    height: 300,
    background: '#ffffff',
    fields: [{ name: 'title', type: 'text', default: 'Title' }],
    layers: [{ id: 'title', type: 'text', text: '{{title}}', x: 40, y: 40, w: 520, h: 220, size: 48, weight: 500, color: '#111111', ...(font ? { font } : {}) }],
  };
}

function padded(bytes: Uint8Array, size: number): Uint8Array {
  const out = new Uint8Array(size);
  out.set(bytes);
  return out;
}

describe('uploads', () => {
  it('stores a picture and reads its type and size from the file itself', async () => {
    const m = await mounted();
    const asset = await uploadAsset(m.t.env, m.db, { name: '../../etc/logo.svg', bytes: tinyPng(64, 32) }, { id: 'usr_1' });
    expect(asset).toMatchObject({ kind: 'image', name: 'logo.svg', contentType: 'image/png', width: 64, height: 32, ref: `asset:${asset.id}`, path: `/i/a/${asset.id}`, font: null });
    expect(m.t.files.store.get(`images/org_test/assets/${asset.id}`)?.httpMetadata?.contentType).toBe('image/png');
    expect((await getAsset(m.db, asset.id)).id).toBe(asset.id);
  });

  it('stores a TrueType font with its family and what it covers', async () => {
    const m = await mounted();
    const asset = await uploadAsset(m.t.env, m.db, { name: 'mono.ttf', bytes: new Uint8Array(await readFile(FONT)) });
    expect(asset.kind).toBe('font');
    expect(asset.contentType).toBe('font/ttf');
    // The family comes from the file's own name table, and the id is that name as a slug.
    expect(asset.font).toMatchObject({ family: 'JetBrains Mono Medium', id: 'c:jetbrains-mono-medium', weight: 500 });
    expect(asset.font!.ranges.length).toBeGreaterThan(0);

    const withFont = titleIn(asset.font!.id);
    const drawn = await previewSvg(m.t.env, m.db, withFont, { title: 'Custom font' });
    expect(drawn.warnings).toEqual([]);
    const fallback = await previewSvg(m.t.env, m.db, titleIn(undefined), { title: 'Custom font' });
    expect(drawn.svg).not.toBe(fallback.svg);

    // Without the file the text is drawn in the default family, and the result says so.
    await deleteAsset(m.t.env, m.db, asset.id);
    const after = await previewSvg(m.t.env, m.db, withFont, { title: 'Custom font' });
    expect(after.warnings).toEqual([{ layer: 'title', code: 'font_missing', detail: asset.font!.id }]);
    expect(after.svg).toBe(fallback.svg);
  });

  it('refuses files it cannot draw', async () => {
    const m = await mounted();
    const upload = (bytes: Uint8Array) => uploadAsset(m.t.env, m.db, { bytes });
    await expect(upload(new Uint8Array(0))).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(upload(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).rejects.toMatchObject({ code: 'images.unsupported_file' });
    await expect(upload(new TextEncoder().encode('wOF2 this is not really a font file at all'))).rejects.toMatchObject({ code: 'images.bad_font' });
    await expect(upload(new TextEncoder().encode('OTTO this is not really a font file at all'))).rejects.toMatchObject({ code: 'images.bad_font' });
    await expect(upload(padded(tinyPng(100, 100), 2 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'too_large' });
    await expect(upload(tinyPng(5000, 100))).rejects.toMatchObject({ code: 'too_large' });
    expect(m.t.files.store.size).toBe(0);
    expect((await listAssets(m.db)).items).toEqual([]);
  });

  it('stops at the workspace’s limit of files', async () => {
    const m = await mounted();
    const insert = m.t.sqlite.prepare(`INSERT INTO img_assets (id, org_id, kind, name, content_type, bytes, created_at) VALUES (?, 'org_test', 'image', 'x.png', 'image/png', 10, 1)`);
    for (let i = 0; i < MAX_ASSETS; i++) insert.run(`imga_fill${i}`);
    await expect(uploadAsset(m.t.env, m.db, { bytes: tinyPng() })).rejects.toMatchObject({ code: 'images.storage_full' });
  });

  it('lists by kind, a page at a time', async () => {
    const m = await mounted();
    for (let i = 0; i < 3; i++) await uploadAsset(m.t.env, m.db, { name: `p${i}.png`, bytes: tinyPng(10 + i, 10) }, {}, 1_700_000_000_000 + i * 1000);
    await uploadAsset(m.t.env, m.db, { bytes: new Uint8Array(await readFile(FONT)) }, {}, 1_700_000_010_000);
    const pictures = await listAssets(m.db, { kind: 'image', limit: 2 });
    expect(pictures.items.map((a) => a.name)).toEqual(['p2.png', 'p1.png']);
    const rest = await listAssets(m.db, { kind: 'image', limit: 2, cursor: pictures.nextCursor });
    expect(rest.items.map((a) => a.name)).toEqual(['p0.png']);
    expect((await listAssets(m.db, { kind: 'font' })).items).toHaveLength(1);
    expect((await listAssets(m.db)).items).toHaveLength(4);
  });

  it('draws an uploaded picture into the image, and an empty box once it is deleted', async () => {
    const m = await mounted();
    const asset = await uploadAsset(m.t.env, m.db, { bytes: tinyPng() });
    const doc = blankDoc(400, 200);
    const withPicture = { ...doc, layers: [...doc.layers, { id: 'logo', type: 'image' as const, x: 10, y: 10, w: 50, h: 50, src: asset.ref }] };
    const drawn = await previewSvg(m.t.env, m.db, withPicture);
    expect(drawn.svg).toContain('data:image/png;base64,');
    expect(drawn.warnings).toEqual([]);
    await deleteAsset(m.t.env, m.db, asset.id);
    const after = await previewSvg(m.t.env, m.db, withPicture);
    expect(after.svg).not.toContain('data:image/png');
    expect(after.warnings.map((w) => w.code)).toEqual(['image_missing']);
  });

  it('keeps one workspace’s files out of another’s lists and images', async () => {
    const m = await mounted();
    const other = orgDb(m.t.env.DB, 'org_other');
    const theirs = await uploadAsset(m.t.env, other, { bytes: tinyPng() });
    await expect(getAsset(m.db, theirs.id)).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteAsset(m.t.env, m.db, theirs.id)).rejects.toMatchObject({ code: 'not_found' });
    const doc = blankDoc(400, 200);
    const borrowed = { ...doc, layers: [...doc.layers, { id: 'logo', type: 'image' as const, x: 10, y: 10, w: 50, h: 50, src: theirs.ref }] };
    const drawn = await previewSvg(m.t.env, m.db, borrowed);
    expect(drawn.svg).not.toContain('data:image/png');
    expect(drawn.warnings.map((w) => w.code)).toEqual(['image_missing']);
  });
});

describe('the public copy of an upload', () => {
  it('is served to anyone with the address, and never changes', async () => {
    const m = await mounted();
    const png = tinyPng(8, 8);
    const asset = await uploadAsset(m.t.env, m.db, { bytes: png });
    const res = await m.visitor.request(asset.path);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
  });

  it('is gone when the file is deleted, the module is off, or the id is not one of ours', async () => {
    const m = await mounted();
    const asset = await uploadAsset(m.t.env, m.db, { bytes: tinyPng() });
    expect(await publicAsset(m.t.env, 'imga_../../secrets')).toBeNull();
    expect((await m.visitor.request('/i/a/imga_0000000000000000000000')).status).toBe(404);
    expect((await m.visitor.request('/i/a/nope')).status).toBe(404);

    await setModuleEnabled(m.t.env, m.t.org.id, 'images', false);
    expect((await m.visitor.request(asset.path)).status).toBe(404);
    await setModuleEnabled(m.t.env, m.t.org.id, 'images', true);
    expect((await m.visitor.request(asset.path)).status).toBe(200);

    await deleteAsset(m.t.env, m.db, asset.id);
    const gone = await m.visitor.request(asset.path);
    expect(gone.status).toBe(404);
    expect(gone.headers.get('cache-control')).toBe('no-store');
  });
});
