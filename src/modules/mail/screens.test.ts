import { describe, expect, it } from 'vitest';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import mailModule from './module';
import { addPeople, fixture, T0 } from './testkit';
import { createBroadcast } from './broadcasts';
import { saveSequence } from './sequences';
import { createTemplate } from './transactional';
import { saveSegment } from './lists';

async function setup(opts: Parameters<typeof fixture>[0] = {}) {
  const f = await fixture(opts);
  const app = await mountModule(f.t, mailModule);
  return { f, app };
}
const post = (app: MountedModule, path: string, form: Record<string, string> = {}) => app.request(path, { method: 'POST', form, redirect: 'manual' });

describe('mail screens render', () => {
  it('every screen answers 200 with a stylesheet and no inline handlers', async () => {
    const { f, app } = await setup();
    await addPeople(f, 3);
    const b = await createBroadcast(f.ctx, { list_id: f.list.id, subject: 'Issue 1', body: 'Hello **there**' }, T0);
    await createTemplate(f.ctx, { key: 'receipt', name: 'Receipt', subject: 'Thanks', body: 'Hi {{first_name|friend}}' }, T0);
    const seg = await saveSegment(f.ctx, { name: 'Tagged', filter: { match: 'all', rules: [{ type: 'tag', op: 'has', value: 'vip' }] } });
    const paths = [
      '/app/mail', '/app/mail/lists', `/app/mail/lists/${f.list.id}`, '/app/mail/subscribers', '/app/mail/subscribers/import', '/app/mail/fields',
      '/app/mail/segments', '/app/mail/segments/new', `/app/mail/segments/${seg.id}`, '/app/mail/sequence', '/app/mail/templates', '/app/mail/feeds',
      '/app/mail/stats', '/app/mail/deliverability', '/app/mail/settings', `/app/mail/b/${b.id}`, `/app/mail/b/${b.id}/stats`,
    ];
    for (const p of paths) {
      const res = await app.request(p);
      expect(res.status, p).toBe(200);
      const html = await res.text();
      expect(html, p).toContain('/m/mail/mail.css');
      expect(html, p).not.toMatch(/\sonclick=|\sonchange=|\sonsubmit=/i);
    }
  });

  it('shows empty states and the first run before anything exists', async () => {
    const { app } = await setup();
    const home = await (await app.request('/app/mail')).text();
    expect(home).toContain('No emails yet');
    expect(home).toContain('Get set up in three steps');
    expect(await (await app.request('/app/mail/subscribers')).text()).toContain('No subscribers yet');
    expect(await (await app.request('/app/mail/segments')).text()).toContain('No segments yet');
  });

  it('previews an email as a sandboxed page', async () => {
    const { f, app } = await setup();
    await addPeople(f, 1);
    const b = await createBroadcast(f.ctx, { list_id: f.list.id, subject: 'Hi', body: 'Hello' }, T0);
    const res = await app.request(`/app/mail/b/${b.id}/preview`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(await res.text()).toContain('Hello');
  });
});

describe('mail screen actions', () => {
  it('creates a newsletter, needs an address once, and rejects a taken name field', async () => {
    const { f, app } = await setup({ postal: false });
    const bad = await post(app, '/app/mail/lists', { name: 'Notes' });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('postal address');
    const both = await post(app, '/app/mail/lists', { name: '' });
    expect(both.status).toBe(422);
    expect((await both.text()).match(/err-text|field-error/g)?.length).toBeGreaterThanOrEqual(2);
    const ok = await post(app, '/app/mail/lists', { name: 'Notes', postal: 'Example Ltd, 1 Main Street' });
    expect(ok.status).toBe(303);
    expect(f.t.sqlite.prepare("SELECT COUNT(*) n FROM mail_lists WHERE name = 'Notes'").get()).toEqual({ n: 1 });
  });

  it('edits a draft, sends a test, schedules, and refuses a past time', async () => {
    const { f, app } = await setup();
    await addPeople(f, 2);
    const created = await app.request('/app/mail/new', { redirect: 'manual' });
    expect(created.status).toBe(303);
    const id = created.headers.get('location')!.split('/').pop()!;
    const empty = await post(app, `/app/mail/b/${id}`, { subject: 'x'.repeat(300), body: 'x', list_id: f.list.id, format: 'markdown' });
    expect(empty.status).toBe(422);
    expect(await empty.text()).toMatch(/subject/i);
    expect((await post(app, `/app/mail/b/${id}`, { subject: 'Issue', body: 'Hello', list_id: f.list.id, format: 'markdown', segment: '' })).status).toBe(303);
    expect((await post(app, `/app/mail/b/${id}/test`, { to: 'me@example.com' })).status).toBe(303);
    const past = await post(app, `/app/mail/b/${id}/schedule`, { when: '2020-01-01T10:00' });
    expect(past.status).toBe(422);
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
    expect((await post(app, `/app/mail/b/${id}/schedule`, { when })).status).toBe(303);
    expect(await (await app.request(`/app/mail/b/${id}`)).text()).toContain('Scheduled');
  });

  it('adds a subscriber only with consent, and imports with a report', async () => {
    const { f, app } = await setup();
    const no = await post(app, '/app/mail/subscribers', { email: 'a@example.com', list: f.list.id });
    expect(no.status).toBe(422);
    expect(await no.text()).toContain('field-error');
    expect(f.t.sqlite.prepare('SELECT COUNT(*) n FROM mail_subscribers').get()).toEqual({ n: 0 });
    await post(app, '/app/mail/subscribers', { email: 'a@example.com', list: f.list.id, consent: '1' });
    expect(f.t.sqlite.prepare('SELECT COUNT(*) n FROM mail_subscribers').get()).toEqual({ n: 1 });
    const missing = await post(app, '/app/mail/subscribers/import', { list: f.list.id, csv: 'email\nb@example.com', tags: 'vip' });
    expect(missing.status).toBe(422);
    const missingHtml = await missing.text();
    expect(missingHtml).toContain('email\nb@example.com');
    expect(missingHtml).toContain('vip');
    const done = await post(app, '/app/mail/subscribers/import', { list: f.list.id, csv: 'email,name\nb@example.com,Bee\nbad\n', consent: '1' });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('1 added');
  });

  it('saves a segment from the rule builder and a welcome series', async () => {
    const { f, app } = await setup();
    const seg = await post(app, '/app/mail/segments', { name: 'VIPs', match: 'all', kind0: 'tag:has', value0: 'vip', go: 'save' });
    expect(seg.status).toBe(303);
    const bad = await post(app, '/app/mail/segments', { name: 'Bad', match: 'all', kind0: 'tag:has', value0: '', go: 'save' });
    expect(bad.status).toBe(422);
    const noRules = await post(app, '/app/mail/segments', { name: 'Empty', match: 'all', go: 'save' });
    expect(noRules.status).toBe(422);
    expect(await noRules.text()).toContain('Add at least one rule');
    const s = await post(app, '/app/mail/sequence', { list: f.list.id, delay0: '0', subject0: 'Welcome', body0: 'Hi', go: 'on' });
    expect(s.status).toBe(303);
    expect(await (await app.request(`/app/mail/sequence?list=${f.list.id}`)).text()).toContain('This series is on');
    const none = await post(app, '/app/mail/sequence', { list: f.list.id, delay0: '0', subject0: 'x', go: 'save' });
    expect(none.status).toBe(422);
  });

  it('creates a template, rejects a duplicate key, and blocks bounced addresses', async () => {
    const { app } = await setup();
    expect((await post(app, '/app/mail/templates', { key: 'receipt', name: 'Receipt', subject: 'Thanks', body: 'Hi' })).status).toBe(303);
    expect((await post(app, '/app/mail/templates', { key: 'receipt', name: 'Receipt 2', subject: 'Thanks', body: 'Hi' })).status).toBe(422);
    const r = await post(app, '/app/mail/deliverability/bounced', { addresses: 'gone@example.com, nope' });
    expect(await r.text()).toContain('1 blocked');
    expect(await (await app.request('/app/mail/deliverability')).text()).toContain('gone@example.com');
  });

  it('saves settings and requires a real address', async () => {
    const { app } = await setup();
    expect((await post(app, '/app/mail/settings', { postal: 'x' })).status).toBe(422);
    expect((await post(app, '/app/mail/settings', { postal: '1 Example Street, Springfield', track_opens: '1' })).status).toBe(303);
  });
});

describe('screen details', () => {
  it('links a scheduled email to the editor, where it can be unscheduled', async () => {
    const { f, app } = await setup();
    await addPeople(f, 1);
    const created = await app.request('/app/mail/new', { redirect: 'manual' });
    const id = created.headers.get('location')!.split('/').pop()!;
    await post(app, `/app/mail/b/${id}`, { subject: 'Issue', body: 'Hello', list_id: f.list.id, format: 'markdown', segment: '' });
    const when = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
    await post(app, `/app/mail/b/${id}/schedule`, { when });
    const home = await (await app.request('/app/mail')).text();
    expect(home).toContain(`/app/mail/b/${id}"`);
  });

  it('reports field errors for custom fields and keeps list checkboxes after a refusal', async () => {
    const { f, app } = await setup();
    const bad = await post(app, '/app/mail/fields', { key: '', label: '' });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toMatch(/err-text|field-error/);
    const refused = await post(app, `/app/mail/lists/${f.list.id}`, { name: '', postal: '1 Example Street', archive_public: '1' });
    expect(refused.status).toBe(422);
    expect(await refused.text()).toMatch(/name="archive_public"[^>]*checked|checked[^>]*name="archive_public"/);
  });

  it('names the rule selects for screen readers', async () => {
    const { app } = await setup();
    const html = await (await app.request('/app/mail/segments')).text();
    expect(html).toContain('aria-label');
    expect(html).not.toMatch(/<select[^>]* label=/);
  });
});

describe('viewers', () => {
  it('see the screens without write buttons and cannot post', async () => {
    const { f, app } = await setup();
    await createBroadcast(f.ctx, { list_id: f.list.id, subject: 'Issue 1', body: 'Hello' }, T0);
    const viewer = app.as({ kind: 'session', role: 'viewer' });
    const home = await viewer.request('/app/mail');
    expect(home.status).toBe(200);
    expect(await home.text()).not.toContain('New email');
    expect((await viewer.request('/app/mail/settings')).status).toBe(200);
    expect((await post(viewer, '/app/mail/settings', { postal: '1 Example Street' })).status).toBe(403);
    expect((await viewer.request('/app/mail/new')).status).toBe(403);
    const seg = await (await viewer.request('/app/mail/segments')).text();
    expect(seg).not.toMatch(/<button[^>]*>\s*(Save|Check)/);
  });
});
