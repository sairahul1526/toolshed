import { describe, expect, it } from 'vitest';
import { recentEvents } from '../../core/events';
import { setModuleEnabled } from '../../core/registry';
import { bakePng, OPEN_RATE, previewSvg, renderToStorage } from './serve';
import { saveSettings } from './settings';
import { shareLink } from './share';
import { createTemplate, getTemplate, publishTemplate, updateTemplate } from './templates';
import { blogTemplate, mounted, pathOf, tinyPng, type Mounted } from './test-support';

const BASE = 'http://localhost';

async function signedPath(m: Mounted, templateId: string, input: Record<string, unknown> = {}, now?: number): Promise<string> {
  return pathOf((await shareLink(m.t.env, m.db, templateId, BASE, input, now)).url);
}

function count(m: Mounted, table: string): number {
  return (m.t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('an image by URL', () => {
  it('draws on the first request and serves from storage after that', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const path = await signedPath(m, template.id, { values: { title: 'Hello there' } });

    const first = await m.visitor.request(path);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('image/svg+xml; charset=utf-8');
    expect(first.headers.get('x-images-cache')).toBe('miss');
    expect(first.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(first.headers.get('x-content-type-options')).toBe('nosniff');
    expect(first.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(first.headers.get('set-cookie')).toBeNull();
    const svg = await first.text();
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);

    const second = await m.visitor.request(path);
    expect(second.headers.get('x-images-cache')).toBe('hit');
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(await second.text()).toBe(svg);

    expect(m.t.files.store.size).toBe(1);
    expect(count(m, 'img_renders')).toBe(1);
    expect(count(m, 'img_hits')).toBe(1);
    const after = await getTemplate(m.db, template.id);
    expect(after.renders).toBe(1);
    expect(after.firstRequestAt).not.toBeNull();
  });

  it('answers 304 when the browser already has the image', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const path = await signedPath(m, template.id);
    const etag = (await m.visitor.request(path)).headers.get('etag')!;
    const again = await m.visitor.request(path, { headers: { 'if-none-match': `W/${etag}` } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
  });

  it('refuses a URL without a signature, or with a changed one, in one plain line', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const missing = await m.visitor.request(`/i/${template.slug}.svg?title=Free+image`);
    expect(missing.status).toBe(403);
    expect(missing.headers.get('x-images-error')).toBe('images.signature_required');
    expect(missing.headers.get('cache-control')).toBe('no-store');
    expect(missing.headers.get('content-type')).toContain('text/plain');
    expect(await missing.text()).toContain('needs a signature');

    const path = await signedPath(m, template.id, { values: { title: 'Hello' } });
    const changed = await m.visitor.request(path.replace('title=Hello', 'title=Other'));
    expect(changed.status).toBe(403);
    expect(changed.headers.get('x-images-error')).toBe('images.bad_signature');
    const widened = await m.visitor.request(`${path}&w=2400`);
    expect(widened.headers.get('x-images-error')).toBe('images.bad_signature');
    expect(m.t.files.store.size).toBe(0);
  });

  it('answers a script that asks for JSON with the usual error shape', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const res = await m.visitor.request(`/i/${template.slug}.svg`, { headers: { accept: 'application/json' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'images.signature_required' });
  });

  it('draws unsigned URLs for an open template, from its own fields only', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await updateTemplate(m.db, template.id, { open: true });
    const plain = await m.visitor.request(`/i/${template.slug}.svg?title=Open+image`);
    expect(plain.status).toBe(200);
    expect(plain.headers.get('x-images-cache')).toBe('miss');
    // Parameters the template does not have change nothing, so they cannot be used to fill storage.
    const noise = await m.visitor.request(`/i/${template.slug}.svg?title=Open+image&junk=1&other=2`);
    expect(noise.headers.get('x-images-cache')).toBe('hit');
    expect(m.t.files.store.size).toBe(1);
  });

  it('limits how many new images one visitor can start on an open template', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await updateTemplate(m.db, template.id, { open: true });
    for (let i = 0; i < OPEN_RATE.limit; i++) {
      expect((await m.visitor.request(`/i/${template.slug}.svg?title=Card+${i}`)).status).toBe(200);
    }
    const blocked = await m.visitor.request(`/i/${template.slug}.svg?title=One+too+many`);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('x-images-error')).toBe('rate_limited');
    // Images already made are still served.
    expect((await m.visitor.request(`/i/${template.slug}.svg?title=Card+0`)).status).toBe(200);
  });

  it('stops working after the time a signed URL was given', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const live = await signedPath(m, template.id, { expiresIn: 600 });
    const res = await m.visitor.request(live);
    expect(res.status).toBe(200);
    const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control')!)![1]);
    expect(maxAge).toBeGreaterThan(590);
    expect(maxAge).toBeLessThanOrEqual(600);

    const old = await signedPath(m, template.id, { expiresIn: 600 }, Date.now() - 3_600_000);
    const expired = await m.visitor.request(old);
    expect(expired.status).toBe(410);
    expect(expired.headers.get('x-images-error')).toBe('images.link_expired');
  });

  it('keeps a pinned URL on its version and moves other URLs to the new look', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const pinned = await signedPath(m, template.id, { pin: true });
    const loose = await signedPath(m, template.id);
    const before = await m.visitor.request(pinned);
    expect(before.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const old = await before.text();
    expect(await (await m.visitor.request(loose)).text()).toBe(old);

    await updateTemplate(m.db, template.id, { doc: { ...template.doc, background: '#ffffff' } });
    await publishTemplate(m.t.env, m.db, template.id);

    const pinnedAfter = await m.visitor.request(pinned);
    expect(pinnedAfter.headers.get('x-images-cache')).toBe('hit');
    expect(await pinnedAfter.text()).toBe(old);
    const looseAfter = await m.visitor.request(loose);
    expect(looseAfter.headers.get('x-images-cache')).toBe('miss');
    expect(await looseAfter.text()).not.toBe(old);
  });

  it('draws the current look when an old pinned image is no longer stored', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const pinned = await signedPath(m, template.id, { pin: true });
    await updateTemplate(m.db, template.id, { doc: { ...template.doc, background: '#ffffff' } });
    await publishTemplate(m.t.env, m.db, template.id);
    const res = await m.visitor.request(pinned);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
    expect(await res.text()).toContain('#ffffff');
  });

  it('has nothing to show for a draft, an unknown name, or a workspace with the module off', async () => {
    const m = await mounted();
    const draft = await createTemplate(m.t.env, m.db, { starter: 'blog' });
    const unpublished = await m.visitor.request(`/i/${draft.slug}.svg`);
    expect(unpublished.status).toBe(404);
    expect(unpublished.headers.get('x-images-error')).toBe('images.not_published');
    expect((await m.visitor.request('/i/no-such-card.svg')).status).toBe(404);
    expect((await m.visitor.request('/i/no-such-card.gif')).status).toBe(404);

    const live = await blogTemplate(m);
    const path = await signedPath(m, live.id);
    expect((await m.visitor.request(path)).status).toBe(200);
    await setModuleEnabled(m.t.env, m.t.org.id, 'images', false);
    expect((await m.visitor.request(path)).status).toBe(404);
  });

  it('says which problems the image has in a header', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const path = await signedPath(m, template.id, { values: { title: 'مرحبا بالعالم' } });
    const res = await m.visitor.request(path);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-images-warnings')).toContain('complex_script');
  });
});

describe('PNG', () => {
  it('needs a baked file while server PNG is off, and draws one when it is on', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const path = await signedPath(m, template.id, { format: 'png', width: 300 });
    const off = await m.visitor.request(path);
    expect(off.status).toBe(404);
    expect(off.headers.get('x-images-error')).toBe('images.png_needs_bake');

    await saveSettings(m.t.env, m.t.org.id, { serverPng: true });
    const on = await m.visitor.request(path);
    expect(on.status).toBe(200);
    expect(on.headers.get('content-type')).toBe('image/png');
    expect(on.headers.get('content-security-policy')).toBeNull();
    const bytes = new Uint8Array(await on.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const view = new DataView(bytes.buffer);
    expect([view.getUint32(16), view.getUint32(20)]).toEqual([300, 158]);
  });

  it('stores a PNG made in the browser under the address the URL looks for', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const png = tinyPng(600, 315);
    const image = await bakePng(m.t.env, m.db, template.id, png, { values: { title: 'Baked' }, width: 600, base: BASE });
    expect(image).toMatchObject({ format: 'png', width: 600, height: 315, cached: false, bytes: png.byteLength });

    const res = await m.visitor.request(pathOf(image.url));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-images-cache')).toBe('hit');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);

    // The same picture without the pinned version is found too, while the template has not changed.
    const loose = await signedPath(m, template.id, { format: 'png', width: 600, values: { title: 'Baked' } });
    expect((await m.visitor.request(loose)).headers.get('x-images-cache')).toBe('hit');

    const again = await bakePng(m.t.env, m.db, template.id, png, { values: { title: 'Baked' }, width: 600, base: BASE });
    expect(again.cached).toBe(true);
    expect((await getTemplate(m.db, template.id)).renders).toBe(1);
  });

  it('refuses a baked file that is not a PNG of the template’s shape', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const bake = (bytes: Uint8Array, width?: number) => bakePng(m.t.env, m.db, template.id, bytes, { width, base: BASE });
    await expect(bake(tinyPng(1200, 600))).rejects.toMatchObject({ code: 'images.bad_png' });
    await expect(bake(tinyPng(600, 315))).rejects.toMatchObject({ code: 'images.bad_png' });
    await expect(bake(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).rejects.toMatchObject({ code: 'images.bad_png' });
    await expect(bake(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toMatchObject({ code: 'too_large' });
    expect(m.t.files.store.size).toBe(0);
  });
});

describe('limits on new images', () => {
  it('stops new images at the workspace’s daily limit and says so once', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await saveSettings(m.t.env, m.t.org.id, { dailyCap: 2 });
    const paths = await Promise.all(['One', 'Two', 'Three', 'Four'].map((title) => signedPath(m, template.id, { values: { title } })));
    expect((await m.visitor.request(paths[0]!)).status).toBe(200);
    expect((await m.visitor.request(paths[1]!)).status).toBe(200);
    for (const path of [paths[2]!, paths[3]!]) {
      const res = await m.visitor.request(path);
      expect(res.status).toBe(429);
      expect(res.headers.get('x-images-error')).toBe('images.daily_cap');
    }
    expect((await m.visitor.request(paths[0]!)).headers.get('x-images-cache')).toBe('hit');
    const events = (await recentEvents(m.t.env, m.t.org.id, { module: 'images' })).filter((e) => e.name === 'quota.reached');
    expect(events).toHaveLength(1);
    expect(events[0]!.data).toEqual({ kind: 'daily', limit: 2 });
  });

  it('stops a template at its own limit', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await updateTemplate(m.db, template.id, { maxRenders: 1 });
    expect((await m.visitor.request(await signedPath(m, template.id, { values: { title: 'One' } }))).status).toBe(200);
    const res = await m.visitor.request(await signedPath(m, template.id, { values: { title: 'Two' } }));
    expect(res.status).toBe(429);
    expect(res.headers.get('x-images-error')).toBe('images.template_cap');
    const [event] = (await recentEvents(m.t.env, m.t.org.id, { module: 'images' })).filter((e) => e.name === 'quota.reached');
    expect(event!.data).toEqual({ kind: 'template', limit: 1, templateId: template.id });
  });

  it('counts a baked PNG against the daily limit, but not a preview', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await saveSettings(m.t.env, m.t.org.id, { dailyCap: 1 });
    await previewSvg(m.t.env, m.db, template.doc, { title: 'Preview' });
    await previewSvg(m.t.env, m.db, template.doc, { title: 'Preview again' });
    await bakePng(m.t.env, m.db, template.id, tinyPng(1200, 630), { base: BASE });
    await expect(bakePng(m.t.env, m.db, template.id, tinyPng(600, 315), { width: 600, base: BASE })).rejects.toMatchObject({ code: 'images.daily_cap' });
  });
});

describe('an image made through the API', () => {
  it('is stored, counted and announced, and found again the second time', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const image = await renderToStorage(m.t.env, m.db, template.id, { values: { title: 'From the API', nope: 'x' }, format: 'svg', source: 'api', base: BASE });
    expect(image).toMatchObject({ format: 'svg', width: 1200, height: 630, cached: false, warnings: [] });
    expect(image.bytes).toBeGreaterThan(1000);
    expect(image.url).toContain(`/i/${template.slug}.svg?title=From+the+API&v=1&sig=`);

    const [event] = (await recentEvents(m.t.env, m.t.org.id, { module: 'images' })).filter((e) => e.name === 'render.completed');
    expect(event!.data).toEqual({ templateId: template.id, slug: template.slug, format: 'svg', width: 1200, bytes: image.bytes, url: image.url, source: 'api' });

    const served = await m.visitor.request(pathOf(image.url));
    expect(served.headers.get('x-images-cache')).toBe('hit');

    const again = await renderToStorage(m.t.env, m.db, template.id, { values: { title: 'From the API' }, format: 'svg', source: 'api', base: BASE });
    expect(again).toMatchObject({ cached: true, hash: image.hash, url: image.url });
    expect((await getTemplate(m.db, template.id)).renders).toBe(1);
  });

  it('refuses PNG while server PNG is off, and a template that is still a draft', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await expect(renderToStorage(m.t.env, m.db, template.id, { format: 'png', source: 'api', base: BASE })).rejects.toMatchObject({ code: 'images.server_png_off' });
    const draft = await createTemplate(m.t.env, m.db, { starter: 'quote' });
    await expect(renderToStorage(m.t.env, m.db, draft.id, { format: 'svg', source: 'api', base: BASE })).rejects.toMatchObject({ code: 'images.not_published' });
  });
});
