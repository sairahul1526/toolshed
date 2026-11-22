import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { MountedModule } from '../../../test/helpers/app';
import { mountModule } from '../../../test/helpers/app';
import images from './module';
import { saveSettings } from './settings';
import { getTemplate, listTemplates } from './templates';
import { blogTemplate, imagesTestEnv, mounted, pathOf, tinyPng, type Mounted } from './test-support';

const HOME = '/app/images';
const FONT = 'public/m/images/fonts/jetbrains-mono/jetbrains-mono-500-latin.ttf';

const html = (res: Response) => res.text();
const post = (app: MountedModule, path: string, form: Record<string, string> = {}) => app.request(path, { method: 'POST', form, redirect: 'manual' });

/** A form post that carries a file, the way the upload forms send it. */
function upload(app: MountedModule, path: string, parts: Record<string, string | File>): Promise<Response> {
  const body = new FormData();
  for (const [key, value] of Object.entries(parts)) body.append(key, value);
  return app.request(path, { method: 'POST', body, redirect: 'manual' });
}

/** Where a post that worked sends the browser next. */
function went(res: Response): string {
  expect(res.status).toBe(303);
  return res.headers.get('location')!;
}

/** The message a redirect leaves for the next page, read back out of its cookie. */
function flash(res: Response): string {
  const cookie = /ts_flash=([^;]*)/.exec(res.headers.get('set-cookie') ?? '');
  return cookie ? (JSON.parse(decodeURIComponent(decodeURIComponent(cookie[1]!))) as { message: string }).message : '';
}

/** Pages keep to the rules of the dashboard: scripts and styles come from files, never from the markup. */
function tidy(body: string, path: string): void {
  expect(body, path).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
  expect(body, path).not.toMatch(/\sstyle="/);
  expect(body, path).not.toMatch(/\son[a-z]+="/);
}

async function viewerOf(m: Mounted): Promise<MountedModule> {
  return m.app.as({ role: 'viewer' });
}

describe('images dashboard: first run', () => {
  it('shows a finished image, its URL and the meta tags after one click', async () => {
    const m = await mounted();
    const first = await html(await m.app.request(HOME));
    expect(first).toContain('Make your first image');
    expect(first).toContain('name="starter"');
    expect(first).toContain('Use this card');
    expect(first).toContain('/m/images/images.css');
    expect(first).toContain(`${HOME}/starters/`);
    tidy(first, HOME);

    const made = await post(m.app, `${HOME}/new`, { starter: 'blog' });
    expect(flash(made)).toBe('Your image is ready. Change the text, then copy its URL.');
    const where = went(made);
    expect(where).toMatch(/^\/app\/images\/t\/[a-z0-9_]+$/);
    const share = await html(await m.app.request(where));
    expect(share).toContain('Copy image URL');
    expect(share).toContain('Copy meta tags');
    expect(share).toContain('Waiting for your first request');
    expect(share).toMatch(/http:\/\/localhost\/i\/[a-z0-9-]+\.svg\?sig=[A-Za-z0-9_-]+/);
    expect(share).toContain('og:image');
    expect(share).toContain('Social networks need a PNG');
    expect(share).toContain('/m/images/share.js');
    tidy(share, where);

    // The copied URL really is an image, and the page then says the request arrived.
    const url = /value="(http:\/\/localhost\/i\/[^"]+)"/.exec(share)![1]!.replace(/&amp;/g, '&');
    const image = await m.visitor.request(pathOf(url));
    expect(image.status).toBe(200);
    expect(image.headers.get('content-type')).toContain('image/svg+xml');
    const after = await html(await m.app.request(where));
    expect(after).toContain('Received. The first image request arrived');
    expect(after).not.toContain('Waiting for your first request');
  });

  it('puts typed field values into the URL and the preview', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const body = await html(await m.app.request(`${HOME}/t/${template.id}?f.title=Ship+it+%26+rest`));
    expect(body).toContain('title=Ship+it+%26+rest');
    expect(body).toContain('value="Ship it &amp; rest"');
    expect(body).toContain(`${HOME}/t/${template.id}/preview.svg?live=1&amp;f.title=Ship+it+%26+rest`);

    const preview = await m.app.request(`${HOME}/t/${template.id}/preview.svg?live=1&f.title=Ship+it`);
    expect(preview.headers.get('content-type')).toContain('image/svg+xml');
    expect(await preview.text()).toContain('<svg');
  });

  it('says what to do with a PNG URL and with a draft', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const png = await html(await m.app.request(`${HOME}/t/${template.id}?format=png&expires=3600&pin=1`));
    expect(png).toContain('PNG URLs work for images you have made');
    expect(png).toMatch(/\/i\/[a-z0-9-]+\.png\?/);
    expect(png).toContain('Stops working on');
    expect(png).toContain('v=1');

    const draftAt = went(await post(m.app, `${HOME}/new`, { name: 'Banner', preset: 'og' }));
    expect(draftAt).toMatch(/\/edit$/);
    const draft = await html(await m.app.request(draftAt.replace(/\/edit$/, '')));
    expect(draft).toContain('This template is not live yet');
    expect(draft).not.toContain('Copy image URL');
  });
});

describe('images dashboard: templates', () => {
  it('lists templates with a link to the next page', async () => {
    const m = await mounted();
    for (let i = 0; i < 25; i += 1) went(await post(m.app, `${HOME}/new`, { name: `Card ${i + 1}`, preset: 'og' }));
    const names = (body: string) => [...body.matchAll(/class="img-name">(Card \d+)</g)].map((found) => found[1]);
    const first = await html(await m.app.request(HOME));
    expect(names(first)).toHaveLength(24);
    expect(first).toContain('Show more templates');
    const next = /href="(\/app\/images\?cursor=[^"]+)"/.exec(first)![1]!;
    const second = await html(await m.app.request(next.replace(/&amp;/g, '&')));
    expect(names(second)).toHaveLength(1);
    expect(second).not.toContain('Show more templates');
    expect(new Set([...names(first), ...names(second)]).size).toBe(25);
    tidy(first, HOME);
  });

  it('makes an empty canvas of a custom size, and says what is wrong with a bad one', async () => {
    const m = await mounted();
    const page = await html(await m.app.request(`${HOME}/new`));
    expect(page).toContain('Start from a card');
    expect(page).toContain('Empty canvas');
    expect(page).toContain('Import a template file');
    tidy(page, `${HOME}/new`);

    const where = went(await post(m.app, `${HOME}/new`, { name: 'Wide banner', preset: 'custom', width: '1500', height: '500' }));
    const made = await getTemplate(m.db, /\/t\/([^/]+)\/edit$/.exec(where)![1]!);
    expect(made).toMatchObject({ name: 'Wide banner', width: 1500, height: 500, published: false });

    const missing = await post(m.app, `${HOME}/new`, { name: 'No size', preset: 'custom' });
    expect(missing.status).toBe(422);
    const missingBody = await html(missing);
    expect(missingBody).toContain('That didn’t work');
    expect(missingBody).toContain('Type a width in pixels.');
    expect(missingBody).toContain('value="No size"');

    const huge = await post(m.app, `${HOME}/new`, { preset: 'custom', width: '99999', height: '500' });
    expect(huge.status).toBe(422);
    expect((await listTemplates(m.db, { limit: 10 })).items).toHaveLength(1);
  });

  it('exports a template and imports it again', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const file = await m.app.request(`${HOME}/t/${template.id}/export.json`);
    expect(file.headers.get('content-disposition')).toBe(`attachment; filename="${template.slug}.template.json"`);
    const json = await file.text();

    const pasted = went(await post(m.app, `${HOME}/import`, { json }));
    expect(pasted).toMatch(/\/edit$/);
    const uploaded = await upload(m.app, `${HOME}/import`, { file: new File([json], 'card.template.json', { type: 'application/json' }) });
    expect(flash(uploaded)).toContain('Imported "');
    went(uploaded);
    expect((await listTemplates(m.db, { limit: 10 })).items).toHaveLength(3);

    const empty = await post(m.app, `${HOME}/import`, {});
    expect(empty.status).toBe(422);
    expect(await html(empty)).toContain('Choose a file, or paste the text below.');
    const broken = await post(m.app, `${HOME}/import`, { json: '{"not":"a template"' });
    expect(broken.status).toBe(422);
    expect(await html(broken)).toContain('That didn’t work');
  });

  it('saves the plain edit form to the draft and refuses a bad value', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const path = `${HOME}/t/${template.id}/edit`;
    const page = await html(await m.app.request(path));
    expect(page).toContain('data-images-editor');
    expect(page).toContain('/m/images/editor.js');
    expect(page).toContain('data-editor-fallback');
    expect(page).toContain('name="field.title"');
    tidy(page, path);

    expect(went(await post(m.app, path, { 'field.title': 'A new default', background: '#101010' }))).toBe(path);
    const saved = await getTemplate(m.db, template.id);
    expect(saved.doc.fields.find((f) => f.name === 'title')?.default).toBe('A new default');
    expect(saved.doc.background).toBe('#101010');
    expect(saved.unpublishedChanges).toBe(true);
    expect(saved.publishedDoc?.background).not.toBe('#101010');
    expect(await html(await m.app.request(`${HOME}/t/${template.id}`))).toContain('The design has changes that are not published');

    const bad = await post(m.app, path, { background: 'red' });
    expect(bad.status).toBe(422);
    const badBody = await html(bad);
    expect(badBody).toContain('Not saved');
    expect(badBody).toContain('value="red"');
    expect((await getTemplate(m.db, template.id)).doc.background).toBe('#101010');
  });

  it('publishes, drops changes, copies, clears and deletes', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const base = `${HOME}/t/${template.id}`;
    went(await post(m.app, `${base}/edit`, { background: '#202020' }));

    const dropped = await post(m.app, `${base}/revert`);
    expect(went(dropped)).toBe(`${base}/edit`);
    expect((await getTemplate(m.db, template.id)).unpublishedChanges).toBe(false);

    went(await post(m.app, `${base}/edit`, { background: '#303030' }));
    const published = await post(m.app, `${base}/publish`);
    expect(went(published)).toBe(base);
    expect(flash(published)).toContain('Image URLs now show version 2');
    expect((await getTemplate(m.db, template.id)).publishedDoc?.background).toBe('#303030');

    const copy = await post(m.app, `${base}/duplicate`);
    expect(went(copy)).toMatch(/^\/app\/images\/t\/[a-z0-9_]+\/edit$/);
    expect(went(await post(m.app, `${base}/clear`))).toBe(`${base}/settings`);

    const gone = await post(m.app, `${base}/delete`);
    expect(went(gone)).toBe(HOME);
    expect((await m.app.request(base)).status).toBe(404);
    expect((await listTemplates(m.db, { limit: 10 })).items).toHaveLength(1);
    expect((await post(m.app, `${base}/delete`)).status).toBe(404);
  });

  it('changes the name, address and switches, and keeps what was typed when it cannot', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const other = went(await post(m.app, `${HOME}/new`, { starter: 'quote' }));
    const taken = (await getTemplate(m.db, other.split('/').pop()!)).slug;
    const path = `${HOME}/t/${template.id}/settings`;
    const page = await html(await m.app.request(path));
    expect(page).toContain('Name and address');
    expect(page).toContain('Clear stored images?');
    tidy(page, path);

    expect(went(await post(m.app, path, { name: 'Launch notes', slug: 'launch-notes', open: '1', page: '1', maxRenders: '50' }))).toBe(path);
    expect(await getTemplate(m.db, template.id)).toMatchObject({ name: 'Launch notes', slug: 'launch-notes', open: true, page: true, maxRenders: 50 });
    const on = await html(await m.app.request(path));
    expect(on).toContain('http://localhost/i/launch-notes/make');

    const clash = await post(m.app, path, { name: 'Launch notes', slug: taken, maxRenders: 'lots' });
    expect(clash.status).toBe(422);
    const clashBody = await html(clash);
    expect(clashBody).toContain('Not saved');
    expect(clashBody).toContain(`value="${taken}"`);
    expect(clashBody).toContain('value="lots"');
    expect((await getTemplate(m.db, template.id)).slug).toBe('launch-notes');
  });
});

describe('images dashboard: assets, batches, usage and settings', () => {
  it('uploads a picture and a font, lists them and deletes one', async () => {
    const m = await mounted();
    const empty = await html(await m.app.request(`${HOME}/assets`));
    expect(empty).toContain('Upload a file');
    tidy(empty, `${HOME}/assets`);

    const picture = await upload(m.app, `${HOME}/assets`, { file: new File([tinyPng(64, 32)], 'logo.png', { type: 'image/png' }) });
    expect(went(picture)).toBe(`${HOME}/assets`);
    expect(flash(picture)).toContain('Uploaded. Pick it in a picture layer.');
    const font = await upload(m.app, `${HOME}/assets`, { file: new File([await readFile(FONT)], 'mono.ttf') });
    expect(went(font)).toBe(`${HOME}/assets?kind=font`);

    const list = await html(await m.app.request(`${HOME}/assets`));
    expect(list).toContain('logo.png');
    expect(list).toContain('64 × 32');
    const fonts = await html(await m.app.request(`${HOME}/assets?kind=font`));
    expect(fonts).toContain('mono.ttf');
    expect(fonts).not.toContain('logo.png');
    tidy(list, `${HOME}/assets`);

    const nothing = await post(m.app, `${HOME}/assets`, {});
    expect(nothing.status).toBe(422);
    expect(await html(nothing)).toContain('Choose a file to upload.');
    const text = await upload(m.app, `${HOME}/assets`, { file: new File(['hello'], 'notes.txt', { type: 'text/plain' }) });
    expect(text.status).toBe(422);
    expect(await html(text)).toContain('Not uploaded');

    const id = /\/assets\/([a-z0-9_]+)\/delete/.exec(list)![1]!;
    const gone = await post(m.app, `${HOME}/assets/${id}/delete`);
    expect(flash(gone)).toContain('Deleted logo.png.');
    expect(await html(await m.app.request(`${HOME}/assets`))).not.toContain('logo.png');
  });

  it('starts a batch from pasted rows and shows its images when it is done', async () => {
    const m = await mounted();
    const none = await html(await m.app.request(`${HOME}/batch`));
    expect(none).toContain('Publish a template first');
    tidy(none, `${HOME}/batch`);

    const template = await blogTemplate(m);
    const ready = await html(await m.app.request(`${HOME}/batch`));
    expect(ready).toContain('New batch');
    expect(ready).toContain('No batches yet');

    const bad = await post(m.app, `${HOME}/batch`, { templateId: template.id, format: 'svg', csv: 'headline\nHello' });
    expect(bad.status).toBe(422);
    const badBody = await html(bad);
    expect(badBody).toContain('The batch did not start');
    expect(badBody).toContain('headline');

    const started = await post(m.app, `${HOME}/batch`, { templateId: template.id, format: 'svg', csv: 'title\nFirst card\nSecond card' });
    const where = went(started);
    expect(flash(started)).toContain('Started. 2 images will be made in the background.');
    const running = await html(await m.app.request(where));
    expect(running).toContain('This batch is running');
    expect(running).toContain('No rows finished yet');
    tidy(running, where);

    await m.t.drainJobs();
    const done = await html(await m.app.request(where));
    expect(done).not.toContain('This batch is running');
    expect(done).toMatch(/http:\/\/localhost\/i\/[a-z0-9-]+\.svg\?/);
    expect(done).toContain('download.zip');
    expect(await html(await m.app.request(`${HOME}/batch`))).not.toContain('No batches yet');

    const removed = await post(m.app, `${where}/delete`);
    expect(went(removed)).toBe(`${HOME}/batch`);
    expect((await m.app.request(where)).status).toBe(404);
  });

  it('shows real zeros before anything is made, then the images that were', async () => {
    const m = await mounted();
    const empty = await html(await m.app.request(`${HOME}/usage`));
    expect(empty).toContain('Days and times are in UTC');
    expect(empty).toContain('No image requests in this period');
    expect(empty).toContain('No stored images yet');
    expect(empty).toContain('Nothing made yet');
    expect(await html(await m.app.request(`${HOME}/usage?errors=1`))).toContain('No failures');
    tidy(empty, `${HOME}/usage`);

    const template = await blogTemplate(m);
    const share = await html(await m.app.request(`${HOME}/t/${template.id}`));
    const url = /value="(http:\/\/localhost\/i\/[^"]+)"/.exec(share)![1]!.replace(/&amp;/g, '&');
    expect((await m.visitor.request(pathOf(url))).status).toBe(200);
    const used = await html(await m.app.request(`${HOME}/usage?days=7`));
    expect(used).not.toContain('Nothing made yet');
    expect(used).toContain('Image URL, SVG');
    expect(used).toContain('Blog post');

    await saveSettings(m.t.env, m.t.org.id, { serverPng: false, dailyCap: 0, allowedHosts: [] });
    expect(await html(await m.app.request(`${HOME}/usage`))).toContain('New images are switched off');
  });

  it('lets an admin change the workspace settings and nobody else', async () => {
    const m = await mounted();
    const path = `${HOME}/settings`;
    const page = await html(await m.app.request(path));
    expect(page).toContain('name="dailyCap"');
    expect(page).toContain('name="serverPng"');
    tidy(page, path);

    expect(went(await post(m.app, path, { dailyCap: '250', serverPng: '1', allowedHosts: 'images.example.com cdn.example.com' }))).toBe(path);
    const saved = await html(await m.app.request(path));
    expect(saved).toContain('value="250"');
    expect(saved).toContain('images.example.com');

    const bad = await post(m.app, path, { dailyCap: 'many', allowedHosts: 'not a host!' });
    expect(bad.status).toBe(422);
    const badBody = await html(bad);
    expect(badBody).toContain('Not saved');
    expect(badBody).toContain('value="many"');

    const member = m.app.as({ role: 'member' });
    expect((await post(member, path, { dailyCap: '5' })).status).toBe(403);
    expect(await html(await member.request(path))).toContain('Workspace admins can change these settings. You can look.');
    expect(await html(await m.app.request(path))).toContain('value="250"');
  });
});

describe('images dashboard: who may do what', () => {
  it('lets a viewer look at every screen without any way to change things', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const viewer = await viewerOf(m);
    const base = `${HOME}/t/${template.id}`;

    const list = await html(await viewer.request(HOME));
    expect(list).toContain('Blog post');
    expect(list).not.toContain('New template');
    expect(list).not.toContain(`${base}/edit`);

    const share = await html(await viewer.request(base));
    expect(share).toContain('You can look, but not copy URLs');
    expect(share).not.toContain('sig=');
    expect(share).not.toContain('Copy meta tags');

    const edit = await html(await viewer.request(`${base}/edit`));
    expect(edit).toContain('Workspace members can change this design. You can look.');
    expect(edit).not.toContain('data-images-editor');
    expect(edit).not.toContain('/publish');

    const settings = await html(await viewer.request(`${base}/settings`));
    expect(settings).toContain('Workspace members can change these settings. You can look.');
    expect(settings).not.toContain('/delete');
    for (const path of [`${HOME}/assets`, `${HOME}/batch`, `${HOME}/usage`, `${HOME}/settings`]) {
      const res = await viewer.request(path);
      expect(res.status, path).toBe(200);
      const body = await html(res);
      // What is left of a form is there to read: its boxes are switched off and it has no button.
      expect(body, path).not.toMatch(/<button[^>]+type="submit"(?![^>]*formaction="\/api\/auth)/);
      tidy(body, path);
    }

    expect((await viewer.request(`${HOME}/new`)).status).toBe(403);
    for (const path of [`${HOME}/new`, `${HOME}/import`, `${base}/edit`, `${base}/settings`, `${base}/publish`, `${base}/revert`, `${base}/duplicate`, `${base}/clear`, `${base}/delete`, `${HOME}/assets`, `${HOME}/batch`, `${HOME}/settings`]) {
      expect((await post(viewer, path, { starter: 'blog' })).status, path).toBe(403);
    }
    expect((await listTemplates(m.db, { limit: 10 })).items).toHaveLength(1);
  });

  it('keeps one workspace out of another, and stays shut while the module is off', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const elsewhere = await mounted();
    for (const path of [`${HOME}/t/${template.id}`, `${HOME}/t/${template.id}/edit`, `${HOME}/t/${template.id}/settings`, `${HOME}/t/${template.id}/preview.svg`, `${HOME}/t/${template.id}/export.json`]) {
      expect((await elsewhere.app.request(path)).status, path).toBe(404);
    }
    expect((await post(elsewhere.app, `${HOME}/t/${template.id}/delete`)).status).toBe(404);

    const off = await mountModule(imagesTestEnv(), images, { off: true });
    expect((await off.request(HOME)).status).toBeGreaterThanOrEqual(400);
    expect((await m.visitor.request(HOME)).status).toBeGreaterThanOrEqual(300);
  });
});
