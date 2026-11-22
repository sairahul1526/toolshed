import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { setModuleEnabled } from '../../core/registry';
import { saveSettings } from './settings';
import { createTemplate, publishTemplate, updateTemplate, type Template } from './templates';
import { blogTemplate, mounted, pathOf, type Mounted } from './test-support';

/** A published blog card whose generator page is switched on. */
async function withPage(m: Mounted, more: { open?: boolean } = {}): Promise<Template> {
  const template = await blogTemplate(m);
  return updateTemplate(m.db, template.id, { page: true, ...more });
}

describe('generator page', () => {
  it('is a small page with a form made from the template’s fields', async () => {
    const m = await mounted();
    const template = await withPage(m);
    const res = await m.visitor.request(`/i/${template.slug}/make`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-robots-tag')).toBe('noindex');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    // A visitor is never given a cookie.
    expect(res.headers.get('set-cookie')).toBeNull();

    const body = await res.text();
    expect(body).toContain('<title>Blog post');
    expect(body).toContain('<meta property="og:title" content="Blog post"/>');
    expect(body).toContain(`<meta property="og:url" content="http://localhost/i/${template.slug}/make"/>`);
    expect(body).toContain('name="title"');
    expect(body).toContain('Download PNG');
    expect(body).toContain('/m/images/make.js');
    expect(body).toContain(`data-json="/i/${template.slug}/make.json"`);
    // A link preview needs PNG, which this workspace does not draw on the server.
    expect(body).not.toContain('og:image');
    // The template is signed, so the page has no plain form that could make an image without the script.
    expect(body).toContain(`action="/i/${template.slug}/make"`);
    expect(body).not.toContain('Open the image');
    expect(body).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(body).not.toMatch(/\sstyle="/);
    expect(body).not.toMatch(/\son[a-z]+="/);
    // Nothing on the page is loaded from another site.
    expect(body).not.toMatch(/(?:src|action|data-json)="https?:\/\/(?!localhost\/)/);
    expect(body).not.toMatch(/<link[^>]+href="https?:/);

    // The first picture is the template with its own sample text: a signed URL for nothing a visitor typed.
    const src = /<img class="img-make-preview"[^>]* src="([^"]+)"/.exec(body)![1]!.replace(/&amp;/g, '&');
    expect(src).toMatch(/\.svg\?sig=[A-Za-z0-9_-]+$/);
    expect((await m.visitor.request(pathOf(src))).status).toBe(200);

    // The whole page, with its styles, stays well under 30 KB.
    const css = (await readFile('public/assets/public.css')).byteLength + (await readFile('public/m/images/images-public.css')).byteLength;
    expect(body.length + css).toBeLessThan(30_000);
  });

  it('works without a script when the template is open', async () => {
    const m = await mounted();
    const template = await withPage(m, { open: true });
    const body = await (await m.visitor.request(`/i/${template.slug}/make`)).text();
    expect(body).toContain(`action="/i/${template.slug}.svg"`);
    expect(body).toContain('Open the image');
    expect(body).toContain(`src="http://localhost/i/${template.slug}.svg"`);
    const plain = await m.visitor.request(`/i/${template.slug}.svg?title=Typed+by+a+visitor`);
    expect(plain.status).toBe(200);
    expect(await plain.text()).toContain('<svg');
  });

  it('adds a share picture only when the workspace draws PNG on the server', async () => {
    const m = await mounted();
    const template = await withPage(m);
    await saveSettings(m.t.env, m.t.org.id, { serverPng: true, dailyCap: 1000, allowedHosts: [] });
    const body = await (await m.visitor.request(`/i/${template.slug}/make`)).text();
    expect(body).toMatch(new RegExp(`<meta property="og:image" content="http://localhost/i/${template.slug}\\.png\\?sig=[A-Za-z0-9_-]+"/>`));
    expect(body).toContain('<meta name="twitter:card" content="summary_large_image"/>');
  });

  it('hands the script the published design, not the draft', async () => {
    const m = await mounted();
    const template = await withPage(m);
    const draft = structuredClone(template.doc);
    draft.background = '#123456';
    await updateTemplate(m.db, template.id, { doc: draft });
    const res = await m.visitor.request(`/i/${template.slug}/make.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    const data = (await res.json()) as { slug: string; name: string; doc: { background: string; fields: { name: string }[] }; custom: unknown[] };
    expect(data).toMatchObject({ slug: template.slug, name: 'Blog post', custom: [] });
    expect(data.doc.background).not.toBe('#123456');
    expect(data.doc.fields.map((f) => f.name)).toContain('title');

    await publishTemplate(m.t.env, m.db, template.id);
    const after = (await (await m.visitor.request(`/i/${template.slug}/make.json`)).json()) as { doc: { background: string } };
    expect(after.doc.background).toBe('#123456');
  });

  it('shows a name with markup in it as text', async () => {
    const m = await mounted();
    const template = await withPage(m);
    await updateTemplate(m.db, template.id, { name: '<script>alert(1)</script> "card"' });
    const body = await (await m.visitor.request(`/i/${template.slug}/make`)).text();
    expect(body).not.toContain('<script>alert(1)');
    expect(body).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('is not there while the page is off, the design is unpublished or the module is off', async () => {
    const m = await mounted();
    const off = await blogTemplate(m);
    const draft = await createTemplate(m.t.env, m.db, { name: 'Draft only', preset: 'og' });
    await updateTemplate(m.db, draft.id, { page: true });
    for (const path of [`/i/${off.slug}/make`, `/i/${off.slug}/make.json`, `/i/${draft.slug}/make`, '/i/no-such-card/make', '/i/NOT_A_SLUG/make']) {
      expect((await m.visitor.request(path)).status, path).toBe(404);
    }

    const on = await updateTemplate(m.db, off.id, { page: true });
    expect((await m.visitor.request(`/i/${on.slug}/make`)).status).toBe(200);
    await setModuleEnabled(m.t.env, m.t.org.id, 'images', false);
    expect((await m.visitor.request(`/i/${on.slug}/make`)).status).toBe(404);
    expect((await m.visitor.request(`/i/${on.slug}/make.json`)).status).toBe(404);
  });

  it('only fetches pictures that the published design itself names', async () => {
    const m = await mounted();
    const template = await withPage(m);
    for (const src of ['https://example.com/logo.png', 'asset:img_1', '']) {
      const res = await m.visitor.request(`/i/${template.slug}/image?src=${encodeURIComponent(src)}`);
      expect(res.status, src).toBe(404);
      expect(res.headers.get('x-images-error')).toBe('not_found');
    }
  });
});
