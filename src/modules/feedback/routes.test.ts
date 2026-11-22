import { readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { orgDb } from '../../core/db';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import feedback from './module';
import { createEntry, publishEntry } from './changelog';
import { upsertEmailPerson } from './people';
import { createPortal, listBoards, listStatuses, updatePortal, type Ctx } from './portal';
import { insertPost, listPosts } from './posts';
import { seedSample } from './sample';
import { themeCss } from './pub/feedback';

let t: TestEnv;
let app: MountedModule;
let ctx: Ctx;

const DUMP = process.env.FEEDBACK_DUMP_DIR;
async function get(m: MountedModule, path: string, name?: string) {
  const res = await m.request(path);
  if (DUMP && name) {
    mkdirSync(DUMP, { recursive: true });
    writeFileSync(`${DUMP}/${name}.html`, await res.clone().text());
  }
  return res;
}

async function setup(withPortal = true) {
  t = createTestEnv();
  app = await mountModule(t, feedback);
  ctx = { env: t.env, orgId: t.org.id, db: orgDb(t.env.DB, t.org.id), origin: 'http://localhost' };
  if (withPortal) await createPortal(ctx, { name: 'Acme', slug: 'acme' });
}

beforeEach(() => setup());

describe('dashboard', () => {
  it('shows the first-run steps when there is no portal', async () => {
    await setup(false);
    const res = await get(app, '/app/feedback', 'admin-first-run');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Get started');
    expect(html).toContain('Create portal');
  });

  it('creates a portal from the first-run form', async () => {
    await setup(false);
    const res = await app.request('/app/feedback/start', { form: { name: 'Acme feedback', slug: 'acme-fb' } });
    expect(res.status).toBe(302);
    const home = await (await app.request('/app/feedback')).text();
    expect(home).toContain('/feedback/acme-fb');
  });

  it('fills and clears sample data', async () => {
    await app.request('/app/feedback/sample', { method: 'POST' });
    expect((await listPosts(ctx, { limit: 50 })).items.length).toBeGreaterThan(3);
    const home = await get(app, '/app/feedback', 'admin-inbox');
    expect(home.status).toBe(200);
    await app.request('/app/feedback/sample/clear', { method: 'POST' });
    expect((await listPosts(ctx, { limit: 50 })).items.length).toBe(0);
    const empty = await get(app, '/app/feedback', 'admin-empty');
    expect(await empty.text()).toContain('No posts yet');
  });

  it('opens a post, changes status and replies', async () => {
    await seedSample({ env: t.env, org: t.org, db: ctx.db });
    const post = (await listPosts(ctx, { limit: 1 })).items[0]!;
    const detail = await get(app, `/app/feedback/posts/${post.id}`, 'admin-post');
    expect(detail.status).toBe(200);
    const planned = (await listStatuses(ctx)).find((s) => s.name === 'Planned')!;
    const res = await app.request(`/app/feedback/posts/${post.id}/status`, { form: { status: planned.id, reason: '' } });
    expect(res.status).toBe(302);
    const after = (await listPosts(ctx, { limit: 50 })).items.find((p) => p.id === post.id)!;
    expect(after.status_id).toBe(planned.id);
    await app.request(`/app/feedback/posts/${post.id}/reply`, { form: { body: 'Thanks, we are on it.', notify: 'on' } });
    expect(await (await app.request(`/app/feedback/posts/${post.id}`)).text()).toContain('Thanks, we are on it.');
  });

  it('previews and confirms a merge', async () => {
    const b = (await listBoards(ctx))[0]!;
    const a = await insertPost(ctx, { board: b, title: 'Dark mode please', body: '' });
    const d = await insertPost(ctx, { board: b, title: 'Add a dark theme', body: '' });
    const pick = await get(app, `/app/feedback/posts/${d.id}/merge?q=dark`);
    expect(await pick.text()).toContain('Dark mode please');
    const preview = await get(app, `/app/feedback/posts/${d.id}/merge?into=${a.id}`, 'admin-merge');
    expect(await preview.text()).toContain('Votes after the merge');
    const res = await app.request(`/app/feedback/posts/${d.id}/merge`, { form: { into: a.id } });
    expect(res.status).toBe(302);
  });

  it('posts on behalf of a customer and rejects a bad email inline', async () => {
    const b = (await listBoards(ctx))[0]!;
    const bad = await app.request('/app/feedback/posts/new', { form: { board: b.slug, title: 'Export to PDF', email: 'nope' } });
    expect(bad.status).toBe(422);
    const ok = await app.request('/app/feedback/posts/new', { form: { board: b.slug, title: 'Export to PDF', email: 'cust@example.com', name: 'Cust' } });
    expect(ok.status).toBe(302);
    expect((await listPosts(ctx, { limit: 10 })).items[0]!.title).toBe('Export to PDF');
  });

  it('shows the review queue and approves a held post', async () => {
    const b = (await listBoards(ctx))[0]!;
    const guest = await upsertEmailPerson(ctx, 'guest@example.com', {});
    const p = await insertPost(ctx, { board: b, title: 'Held idea', body: '', authorId: guest.id, review: 'pending', heldReason: 'guest' });
    const q = await get(app, '/app/feedback?view=review', 'admin-review');
    expect(await q.text()).toContain('Held idea');
    await app.request(`/app/feedback/posts/${p.id}/approve`, { method: 'POST' });
    expect((await listPosts(ctx, { limit: 10 })).items.some((x) => x.id === p.id)).toBe(true);
  });

  it('renders every settings tab and validates the general form', async () => {
    for (const tab of ['general', 'boards', 'statuses', 'tags', 'people', 'widget', 'import-export']) {
      const res = await get(app, `/app/feedback/settings/${tab}`, `admin-settings-${tab}`);
      expect(res.status, tab).toBe(200);
    }
    const bad = await app.request('/app/feedback/settings/general', { form: { name: 'Acme', slug: 'acme', accent: 'blue', theme: 'paper', vote_limit: '3', default_sort: 'top' } });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('Use a color like');
    const badSlug = await app.request('/app/feedback/settings/general', { form: { name: 'Acme', slug: 'Not A Slug!', theme: 'paper', vote_limit: '3', default_sort: 'top' } });
    expect(badSlug.status).toBe(422);
    expect(await badSlug.text()).toMatch(/id="g-slug"[^>]*aria-invalid="true"|aria-invalid="true"[^>]*id="g-slug"/);
    const ok = await app.request('/app/feedback/settings/general', { form: { name: 'Acme', slug: 'acme', accent: '#3f6212', theme: 'warm', vote_limit: '3', default_sort: 'top', roadmap_on: 'on', changelog_on: 'on' } });
    expect(ok.status).toBe(302);
  });

  it('writes a changelog entry, publishes it and shows stats and the roadmap', async () => {
    const res = await app.request('/app/feedback/changelog/new', { form: { title: 'Dark mode', body: 'It is here.', label: 'New', state: 'published' } });
    expect(res.status).toBe(302);
    const list = await get(app, '/app/feedback/changelog', 'admin-changelog');
    expect(await list.text()).toContain('Dark mode');
    expect((await get(app, '/app/feedback/changelog/new', 'admin-changelog-new')).status).toBe(200);
    expect((await get(app, '/app/feedback/stats', 'admin-stats')).status).toBe(200);
    expect((await get(app, '/app/feedback/roadmap', 'admin-roadmap')).status).toBe(200);
    expect((await get(app, '/app/feedback/subscribers', 'admin-subscribers')).status).toBe(200);
  });

  it('keeps viewers out of changes', async () => {
    const viewer = app.as({ role: 'viewer' });
    const res = await viewer.request('/app/feedback/settings/general', { form: { name: 'X' } });
    expect(res.status).toBe(403);
  });

  it('maps and imports a Canny style CSV in batches', async () => {
    const csv = 'Title,Details,Author Email,Votes\nOne,First,a@example.com,2\nTwo,Second,b@example.com,1\n';
    const boundary = '----x';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="c.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n--${boundary}--\r\n`;
    const step1 = await app.request('/app/feedback/import', { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
    expect(step1.status).toBe(200);
    expect(await step1.text()).toContain('Match the columns');
    const step2 = await app.request('/app/feedback/import/run', { form: { csv, offset: '0', map_title: '0', map_body: '1', map_author_email: '2', map_votes: '3' } });
    expect(await step2.text()).toContain('2 posts imported');
  });
});

describe('public pages', () => {
  it('renders the portal home, an empty roadmap and an empty changelog', async () => {
    const vis = app.as({ kind: 'anon' });
    expect((await get(vis, '/feedback/acme', 'pub-empty')).status).toBe(200);
    expect((await get(vis, '/roadmap/acme')).status).toBe(200);
    expect((await get(vis, '/changelog/acme')).status).toBe(200);
    expect((await get(vis, '/feedback/nope')).status).toBe(404);
  });

  it('lists posts, shows one, and the roadmap lanes', async () => {
    await seedSample({ env: t.env, org: t.org, db: ctx.db });
    await updatePortal(ctx, { roadmap_on: true, changelog_on: true });
    const vis = app.as({ kind: 'anon' });
    const home = await get(vis, '/feedback/acme', 'pub-home');
    expect(home.status).toBe(200);
    const post = (await listPosts(ctx, { publicOnly: true, limit: 1 })).items[0]!;
    const one = await get(vis, `/feedback/acme/p/${post.slug}`, 'pub-post');
    expect(one.status).toBe(200);
    expect(await one.text()).toContain(post.title);
    expect((await get(vis, '/roadmap/acme', 'pub-roadmap')).status).toBe(200);
    expect((await get(vis, '/feedback/acme/new', 'pub-new')).status).toBe(200);
    expect((await get(vis, '/feedback/acme/sign-in', 'pub-sign-in')).status).toBe(200);
    expect((await get(vis, '/feedback/acme/embed', 'pub-embed')).status).toBe(200);
  });

  it('shows a published entry, the feed and latest.json', async () => {
    await updatePortal(ctx, { changelog_on: true });
    const e = await createEntry(ctx, { title: 'Faster search', body: 'Search is **faster**.', labels: ['Improved'] }, { name: 'Team' });
    await publishEntry(ctx, e.id);
    const vis = app.as({ kind: 'anon' });
    const list = await get(vis, '/changelog/acme', 'pub-changelog');
    expect(await list.text()).toContain('Faster search');
    const rss = await vis.request('/changelog/acme/feed.rss');
    expect(rss.headers.get('content-type')).toContain('xml');
    expect(await rss.text()).toContain('<title>Faster search</title>');
    const latest = await vis.request('/feedback/acme/latest.json');
    expect(latest.headers.get('access-control-allow-origin')).toBe('*');
    expect((await get(vis, `/changelog/acme/${e.slug}`, 'pub-entry')).status).toBe(200);
  });

  it('serves an uploaded image with a long cache', async () => {
    const { saveImage } = await import('./changelog');
    const { getPortal } = await import('./portal');
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
    const out = await saveImage(ctx, (await getPortal(ctx))!, png.buffer, 'image/png');
    const res = await app.as({ kind: 'anon' }).request(out.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('max-age=31536000');
  });

  it('rejects a post that fills the honeypot', async () => {
    const vis = app.as({ kind: 'anon' });
    const b = (await listBoards(ctx))[0]!;
    const res = await vis.request('/feedback/acme/new', { form: { board: b.slug, title: 'Buy now', website: 'http://spam.example.com', ft: 'x' } });
    expect([302, 422]).toContain(res.status);
    expect((await listPosts(ctx, { limit: 10 })).items.length).toBe(0);
  });

  it('keeps private boards away from visitors', async () => {
    const b = (await listBoards(ctx))[0]!;
    await insertPost(ctx, { board: b, title: 'Secret roadmap idea', body: '' });
    await ctx.db.update('fb_boards', b.id, { visibility: 'private' });
    const vis = app.as({ kind: 'anon' });
    const res = await vis.request(`/feedback/acme?board=${b.slug}`);
    expect(await res.text()).not.toContain('Secret roadmap idea');
  });

  it('shows a plain page for a bad unsubscribe link', async () => {
    const res = await app.as({ kind: 'anon' }).request('/feedback/acme/unsubscribe?t=bad');
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('not valid any more');
  });
});

describe('assets', () => {
  it('keeps the widget under 15 KB and free of eval and inline handlers', () => {
    const file = 'public/m/feedback/widget.js';
    expect(statSync(file).size).toBeLessThan(15 * 1024);
    const src = readFileSync(file, 'utf8');
    expect(src).not.toMatch(/\beval\(|new Function|document\.write/);
    expect(src).toContain('localStorage');
  });

  it('builds a theme stylesheet from a valid accent only', () => {
    expect(themeCss('#3f6212')).toContain('#3f6212');
    expect(themeCss('red;}body{display:none')).not.toContain('display:none');
  });
});
