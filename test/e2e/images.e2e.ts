import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, test, type Page, type Route } from '@playwright/test';
import { starterByKey } from '../../src/modules/images/starters';

// The sign-in system is not part of this checkout, so nobody can open the dashboard in a browser yet.
// The test seeds two published templates straight into the local database and then:
// - walks the public side as a visitor, against the real Worker: image URLs, the cache, the generator page;
// - runs the real editor and share scripts in a page that has the same hooks as the dashboard screens,
//   with the API answered by the test, so the layer editor and "Make a PNG" run in a real browser.
const PORT = process.env.PORT ?? '8787';
const SHOTS = '.shots';
const NOW = Date.now();
const SIGNED = 'e2e-signed-card';
const OPEN = 'e2e-open-card';
const API = '/api/v1/images';
const DOC = starterByKey('blog')!.doc;

function seed(): void {
  const doc = JSON.stringify(DOC).replace(/'/g, "''");
  const row = (id: string, slug: string, name: string, open: number) =>
    `INSERT OR REPLACE INTO img_templates (id, org_id, slug, name, doc, published_doc, version, open, page, starter, created_at, updated_at, published_at)
      VALUES ('${id}', 'org_e2e', '${slug}', '${name}', '${doc}', '${doc}', 1, ${open}, 1, 'blog', ${NOW}, ${NOW}, ${NOW})`;
  const sql = `INSERT OR REPLACE INTO module_state (org_id, module_id, enabled, enabled_at) VALUES ('org_e2e', 'images', 1, ${NOW});
    ${row('tpl_e2e_signed', SIGNED, 'Signed card', 0)};
    ${row('tpl_e2e_open', OPEN, 'Open card', 1)}`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `.wrangler/e2e-${PORT}`, '--command', sql], { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

const noSideScroll = (page: Page) => page.evaluate<boolean>('document.documentElement.scrollWidth <= window.innerWidth');

/** Width and height of a PNG file, read from its header. Throws when the bytes are not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The signed address of the sample image, as the generator page hands it to any visitor. */
async function sampleUrl(page: Page): Promise<string> {
  await page.goto(`/i/${SIGNED}/make`);
  const html = await (await page.request.get(`/i/${SIGNED}/make`)).text();
  const src = /<img class="img-make-preview"[^>]* src="([^"]+)"/.exec(html)![1]!.replace(/&amp;/g, '&');
  expect(src).toMatch(/\.svg\?sig=/);
  return new URL(src).pathname + new URL(src).search;
}

test.beforeAll(() => seed());

test('image URL: drawn on the first request, then served from storage', async ({ page }) => {
  const url = await sampleUrl(page);

  const first = await page.request.get(url);
  expect(first.status()).toBe(200);
  expect(first.headers()['content-type']).toContain('image/svg+xml');
  expect(first.headers()['cache-control']).toMatch(/^public, max-age=\d+/);
  expect(first.headers()['content-security-policy']).toContain("default-src 'none'");
  expect(first.headers()['set-cookie']).toBeUndefined();
  const etag = first.headers()['etag']!;
  expect(etag).toMatch(/^"[0-9a-f]+"$/);
  const svg = await first.text();
  expect(svg).toMatch(/^<svg[^>]* width="1200" height="630"/);
  // The picture carries everything it needs: nothing in it points at another address.
  expect(svg).not.toMatch(/(?:href|src)="https?:/);

  // The second request finds the stored file. The store is written after the first answer, so give it a moment.
  await expect.poll(async () => (await page.request.get(url)).headers()['x-images-cache']).toBe('hit');
  const again = await page.request.get(url);
  expect(await again.text()).toBe(svg);
  expect((await page.request.get(url, { headers: { 'if-none-match': etag } })).status()).toBe(304);

  // A signed URL cannot be changed, and a signed template gives nothing without a signature.
  const changed = await page.request.get(`${url}&title=Free+money`);
  expect(changed.status()).toBe(403);
  expect(changed.headers()['x-images-error']).toBe('images.bad_signature');
  const bare = await page.request.get(`/i/${SIGNED}.svg?title=Free+money`);
  expect(bare.status()).toBe(403);
  expect(bare.headers()['x-images-error']).toBe('images.signature_required');

  // PNG on the first request needs server drawing, which is off unless a workspace turns it on.
  const png = await page.request.get(`/i/${OPEN}.png`);
  expect(png.status()).toBe(404);
  expect(await png.text()).toContain('has not been made yet');
  expect((await page.request.get('/i/no-such-card.svg')).status()).toBe(404);

  await page.goto(url);
  await page.screenshot({ path: `${SHOTS}/images-url-svg.png` });
});

test('open template: anyone can set its fields, and only its fields', async ({ page }) => {
  const plain = await page.request.get(`/i/${OPEN}.svg`);
  expect(plain.status()).toBe(200);
  const typed = await page.request.get(`/i/${OPEN}.svg?title=${encodeURIComponent('Typed by a visitor')}`);
  expect(typed.status()).toBe(200);
  expect(await typed.text()).not.toBe(await plain.text());
  // A name the template does not have is dropped, so it draws, and stores, the same picture as the plain address.
  const stray = await page.request.get(`/i/${OPEN}.svg?nope=1`);
  expect(stray.status()).toBe(200);
  expect(stray.headers()['etag']).toBe(plain.headers()['etag']);
});

test('generator page: type a title, the picture follows, download a PNG', async ({ page, context }) => {
  const problems = watch(page);
  const res = await page.goto(`/i/${SIGNED}/make`);
  expect(res?.status()).toBe(200);
  expect((await res!.body()).length).toBeLessThan(30 * 1024);
  await expect(page.getByRole('heading', { name: 'Signed card' })).toBeVisible();

  const preview = page.locator('[data-make-preview]');
  // The script swaps the server's sample image for one drawn in this browser.
  await expect(preview).toHaveAttribute('src', /^blob:/);
  const drawn = await preview.getAttribute('src');
  const before = await preview.screenshot();
  await page.getByLabel('Title', { exact: true }).fill('Made by a visitor in the browser');
  await expect(preview).not.toHaveAttribute('src', drawn!);
  await expect.poll(async () => Buffer.compare(before, await preview.screenshot())).not.toBe(0);

  const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download PNG' }).click()]);
  expect(file.suggestedFilename()).toMatch(/\.png$/);
  expect(pngSize(readFileSync((await file.path())!))).toEqual({ width: 1200, height: 630 });
  await expect(page.locator('[data-make-status]')).toHaveText('Saved as a 1200 × 630 PNG file.');

  // Nothing a visitor does here sets a cookie.
  expect(await context.cookies()).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/images-generator.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/images-generator-dark.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.setViewportSize({ width: 375, height: 760 });
  expect(await noSideScroll(page)).toBe(true);
  await expect(page.getByRole('button', { name: 'Download PNG' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/images-generator-375.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('generator page of an open template works without a script', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`/i/${OPEN}/make`);
  await page.getByLabel('Title', { exact: true }).fill('No script needed');
  await page.screenshot({ path: `${SHOTS}/images-generator-no-script.png`, fullPage: true });
  const [answer] = await Promise.all([page.waitForResponse((r) => r.url().includes(`/i/${OPEN}.svg`)), page.getByRole('button', { name: 'Open the image' }).click()]);
  expect(answer.status()).toBe(200);
  expect(answer.headers()['content-type']).toContain('image/svg+xml');
  expect(new URL(answer.url()).searchParams.get('title')).toBe('No script needed');
  expect(await context.cookies()).toHaveLength(0);
  await context.close();
});

test('module files are served, and the dashboard and API ask for sign-in', async ({ request }) => {
  for (const [path, type] of [
    ['/m/images/editor.js', 'javascript'],
    ['/m/images/share.js', 'javascript'],
    ['/m/images/make.js', 'javascript'],
    ['/m/images/images.css', 'text/css'],
    ['/m/images/images-public.css', 'text/css'],
  ] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type'], path).toContain(type);
  }
  const font = await request.get('/m/images/fonts/jetbrains-mono/jetbrains-mono-500-latin.ttf');
  expect(font.status()).toBe(200);
  expect((await font.body()).length).toBeGreaterThan(10_000);

  const dash = await request.get('/app/images', { maxRedirects: 0 });
  expect([301, 302, 303, 401, 403, 501]).toContain(dash.status());
  expect((await request.get(`${API}/templates`)).status()).toBe(401);
  expect((await request.post(`${API}/render`, { data: { template: 'tpl_e2e_open' } })).status()).toBe(401);
});

// --- The dashboard scripts, in a page with the same hooks as the real screens -----------------------

const attr = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

function shell(script: string, body: string, theme = 'light'): string {
  return `<!doctype html><html lang="en" data-theme="${theme}" data-theme-lock><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Images</title><link rel="stylesheet" href="/assets/toolshed.css"><link rel="stylesheet" href="/m/images/images.css">
    <script type="module" src="/m/images/${script}"></script></head><body><main class="img-editor">${body}</main></body></html>`;
}

function editorHtml(theme?: string): string {
  return shell('editor.js', `
    <div class="img-publish">
      <p class="img-status" role="status" data-editor-status>Published. Image URLs show this design.</p>
      <form method="post" action="/e2e/publish" data-editor-publish><button type="submit" class="btn primary" disabled data-editor-publish-button>Publish</button></form>
    </div>
    <div class="img-editor" data-images-editor data-template="tpl_e2e_signed" data-api="${API}" data-doc="${attr(DOC)}" data-custom="[]" data-pictures="[]" data-hosts="[]" data-assets-href="/app/images/assets"></div>
    <div data-editor-fallback><p>Change text and colours</p></div>`, theme);
}

function shareHtml(): string {
  const title = DOC.fields.find((field) => field.name === 'title')!;
  return shell('share.js', `
    <div class="img-share" data-images-share data-template="tpl_e2e_signed" data-api="${API}" data-doc="${attr(DOC)}" data-custom="[]" data-can-write="1">
      <form method="get" action="/e2e/share" class="form" data-share-form>
        <div class="field"><label class="lbl" for="field-title">Title</label><input class="input" id="field-title" name="f.title" value="${attr(title.default)}" data-field="title"></div>
        <button type="submit" class="btn">Update image</button>
      </form>
      <div class="img-share-out">
        <img class="img-preview" alt="Preview" width="1200" height="630" data-share-preview>
        <p class="img-status muted" role="status" data-share-status></p>
        <input class="input mono" readonly value="" aria-label="Image URL" data-share-url>
        <button type="button" class="btn" data-copy="" data-share-copy-url>Copy image URL</button>
        <div data-share-tags><pre><code></code></pre></div>
        <button type="button" class="btn" hidden data-share-bake>Make a PNG</button>
        <button type="button" class="btn" data-copy="" data-share-copy-tags>Copy meta tags</button>
        <div data-share-html><pre><code></code></pre></div>
      </div>
    </div>`);
}

type Doc = typeof DOC;
const layerOf = (doc: Doc, id: string) => doc.layers.find((layer) => layer.id === id)!;

test('editor: change a text layer, drag, undo and add a layer, saving as it goes', async ({ page }) => {
  const problems = watch(page);
  const saves: Doc[] = [];
  await page.route('**/e2e/editor', (route) => route.fulfill({ contentType: 'text/html', body: editorHtml() }));
  await page.route(`**${API}/**`, async (route: Route) => {
    const request = route.request();
    expect(request.method()).toBe('PATCH');
    expect(new URL(request.url()).pathname).toBe(`${API}/templates/tpl_e2e_signed`);
    saves.push((request.postDataJSON() as { doc: Doc }).doc);
    await route.fulfill({ json: { template: { published: true, unpublishedChanges: true } } });
  });
  const last = () => saves[saves.length - 1]!;

  await page.goto('/e2e/editor');
  await expect(page.getByRole('toolbar', { name: 'Add layers, undo and redo' })).toBeVisible();
  await expect(page.locator('[data-editor-fallback]')).toBeHidden();
  await expect(page.locator('.img-ed-image')).toHaveAttribute('src', /^blob:/);
  await expect(page.locator('.img-ed-layer')).toHaveCount(DOC.layers.length);

  // Change what a text layer says.
  await page.locator('.img-ed-layer-name', { hasText: 'Title' }).click();
  const words = page.locator('.img-ed-props textarea');
  await expect(words).toHaveValue('{{title}}');
  await words.fill('New: {{title}}');
  await expect.poll(() => saves.length).toBeGreaterThan(0);
  expect(layerOf(last(), 'title')).toMatchObject({ text: 'New: {{title}}' });
  await expect(page.locator('[data-editor-status]')).toHaveText('Saved. Publish to change your image URLs.');
  await expect(page.locator('[data-editor-publish-button]')).toBeEnabled();

  // Drag the author line up and to the right on the stage.
  const start = layerOf(DOC, 'author');
  const box = (await page.locator('.img-ed-hit[data-layer="author"]').boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y - 24, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => layerOf(last(), 'author').x).toBeGreaterThan(start.x);
  expect(layerOf(last(), 'author').y).toBeLessThan(start.y);

  // Undo puts it back, and the arrow keys nudge it by one.
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => layerOf(last(), 'author').x).toBe(start.x);
  expect(layerOf(last(), 'author').y).toBe(start.y);
  await page.locator('.img-ed-canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => layerOf(last(), 'author').x).toBe(start.x + 1);

  await page.getByRole('button', { name: 'Rectangle', exact: true }).click();
  await expect(page.locator('.img-ed-layer')).toHaveCount(DOC.layers.length + 1);
  await expect.poll(() => last().layers.length).toBe(DOC.layers.length + 1);
  expect(layerOf(last(), 'title')).toMatchObject({ text: 'New: {{title}}' });

  await page.screenshot({ path: `${SHOTS}/images-editor.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 760 });
  expect(await noSideScroll(page)).toBe(true);
  await page.screenshot({ path: `${SHOTS}/images-editor-375.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('editor in dark mode', async ({ page }) => {
  const problems = watch(page);
  await page.route('**/e2e/editor', (route) => route.fulfill({ contentType: 'text/html', body: editorHtml('dark') }));
  await page.goto('/e2e/editor');
  await expect(page.locator('.img-ed-image')).toHaveAttribute('src', /^blob:/);
  await page.locator('.img-ed-layer-name', { hasText: 'Title' }).click();
  await expect(page.locator('.img-ed-props textarea')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/images-editor-dark.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('use page: the URL follows the fields, and Make a PNG stores a real PNG', async ({ page }) => {
  const problems = watch(page);
  const baked: { size: { width: number; height: number }; title: string | null }[] = [];
  await page.route('**/e2e/share', (route) => route.fulfill({ contentType: 'text/html', body: shareHtml() }));
  await page.route(`**${API}/**`, async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname.endsWith('/url')) {
      const { values } = request.postDataJSON() as { values: Record<string, string> };
      const image = `${url.origin}/i/${SIGNED}.svg?title=${encodeURIComponent(values.title ?? '')}&sig=from-the-server`;
      return route.fulfill({ json: { url: image, format: 'svg', width: 1200, height: 630, signed: true, expiresAt: null, metaTags: `<meta property="og:image" content="${image}">` } });
    }
    if (request.method() === 'POST' && url.pathname.endsWith('/bake')) {
      expect(request.headers()['content-type']).toBe('image/png');
      const bytes = request.postDataBuffer()!;
      baked.push({ size: pngSize(bytes), title: url.searchParams.get('title') });
      return route.fulfill({ status: 201, json: { image: { bytes: bytes.length }, metaTags: `<meta property="og:image" content="${url.origin}/i/${SIGNED}.png?sig=stored">` } });
    }
    // The page also asks now and then whether the first image request has arrived.
    return route.fulfill({ json: { template: { firstRequestAt: null } } });
  });

  await page.goto('/e2e/share');
  await expect(page.locator('[data-share-preview]')).toHaveAttribute('src', /^blob:/);
  await page.getByLabel('Title').fill('A title typed on the use page');
  await expect(page.locator('[data-share-url]')).toHaveValue(/title=A%20title%20typed%20on%20the%20use%20page&sig=from-the-server$/);
  await expect(page.locator('[data-share-copy-url]')).toHaveAttribute('data-copy', /sig=from-the-server$/);
  await expect(page.locator('[data-share-html] code')).toContainText('width="1200" height="630"');
  expect(new URL(page.url()).searchParams.get('f.title')).toBe('A title typed on the use page');

  const bake = page.getByRole('button', { name: 'Make a PNG' });
  await expect(bake).toBeVisible();
  await bake.click();
  await expect(page.locator('[data-share-status]')).toContainText('PNG stored');
  expect(baked).toEqual([{ size: { width: 1200, height: 630 }, title: 'A title typed on the use page' }]);
  await expect(page.locator('[data-share-tags] code')).toContainText('.png?sig=stored');
  await expect(page.locator('[data-share-copy-tags]')).toHaveAttribute('data-copy', /\.png\?sig=stored/);

  // A stored PNG belongs to the words it was made from: change them and the page says so.
  await page.getByLabel('Title').fill('Changed after the PNG');
  await expect(page.locator('[data-share-status]')).toContainText('Press Make a PNG again');
  await page.screenshot({ path: `${SHOTS}/images-use.png`, fullPage: true });
  expect(problems).toEqual([]);
});
