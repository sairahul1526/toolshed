import { beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import forms from './module';
import { findPublic } from './service';
import { issueLoadToken } from './submit';

let t: TestEnv;
let app: MountedModule;

beforeEach(async () => {
  t = createTestEnv();
  app = await mountModule(t, forms);
});

const html = async (path: string) => {
  const res = await app.request(path);
  return { res, text: await res.text() };
};

async function make(templateId = 'contact') {
  const res = await app.request('/app/forms/new', { form: { templateId }, redirect: 'manual' });
  expect(res.status).toBe(303);
  const loc = res.headers.get('location') ?? '';
  return /forms\/([^/]+)\/edit/.exec(loc)![1]!;
}

async function respond(_id: string, slug: string, answers: Record<string, unknown>) {
  // An aged token: a post that comes back instantly is treated as a bot.
  const pf = (await findPublic(t.env, slug))!;
  const token = await issueLoadToken(t.env, pf.form, Date.now() - 20_000);
  return app.as({ kind: 'anon' }).request(`/f/${slug}/submit`, { json: { answers, _token: token, _cid: 'c1', _gotcha: '' } });
}

describe('forms list', () => {
  it('starts with templates and a sample switch when empty', async () => {
    const { res, text } = await html('/app/forms');
    expect(res.status).toBe(200);
    for (const name of ['Contact', 'Waitlist', 'Blank']) expect(text).toContain(name);
    expect(text).toContain('Add sample forms');
  });

  it('creates a form from a template and lists it', async () => {
    const id = await make('feedback-nps');
    const { text } = await html('/app/forms');
    expect(text).toContain(`/app/forms/${id}/`);
    expect(text).not.toContain('Start from a template');
  });

  it('turns sample forms on and off', async () => {
    await app.request('/app/forms/sample', { form: { on: '1' }, redirect: 'manual' });
    expect((await html('/app/forms')).text).toContain('Sample forms are on');
    await app.request('/app/forms/sample', { form: { on: '0' }, redirect: 'manual' });
    expect((await html('/app/forms')).text).not.toContain('Sample forms are on');
  });

  it('moves a form to the trash and back', async () => {
    const id = await make();
    await app.request(`/app/forms/${id}/trash`, { form: {}, redirect: 'manual' });
    expect((await html('/app/forms?view=trash')).text).toContain('Restore');
    await app.request(`/app/forms/${id}/restore`, { form: {}, redirect: 'manual' });
    expect((await html('/app/forms')).text).toContain('Duplicate');
  });

  it('does not let viewers change anything', async () => {
    const res = await app.as({ role: 'viewer' }).request('/app/forms/new', { form: { templateId: 'contact' }, redirect: 'manual' });
    expect(res.status).toBe(403);
  });
});

describe('builder page', () => {
  it('embeds the draft and loads the script', async () => {
    const id = await make();
    const { res, text } = await html(`/app/forms/${id}/edit`);
    expect(res.status).toBe(200);
    expect(text).toContain('id="fb-data"');
    expect(text).toContain('/m/forms/builder.js');
    expect(text).toContain('id="fb-publish"');
    expect(text).not.toMatch(/ style="/);
    const json = /<script type="application\/json" id="fb-data">(.*?)<\/script>/s.exec(text)![1]!;
    expect(JSON.parse(json).definition.pages.length).toBeGreaterThan(0);
  });
});

describe('responses, summary, share, settings, import', () => {
  async function live() {
    const id = await make();
    await app.request(`/app/forms/${id}/publish`, { form: {}, redirect: 'manual' });
    const slug = /\/f\/([a-z0-9-]+)/.exec((await html(`/app/forms/${id}/share`)).text)![1]!;
    return { id, slug };
  }

  it('shows an empty state, then a response, its detail and notes', async () => {
    const { id, slug } = await live();
    expect((await html(`/app/forms/${id}/responses`)).text).toContain('No responses yet');
    const sent = await respond(id, slug, { q_name: 'Ada', q_email: 'ada@example.com', q_message: 'Hello there' });
    expect(sent.status).toBe(200);
    const list = (await html(`/app/forms/${id}/responses`)).text;
    expect(list).toContain('Ada');
    const sid = /name="ids" value="([^"]+)"/.exec(list)![1]!;
    const detail = await html(`/app/forms/${id}/responses/${sid}`);
    expect(detail.text).toContain('Hello there');
    await app.request(`/app/forms/${id}/responses/${sid}/notes`, { form: { body: 'Call back' }, redirect: 'manual' });
    expect((await html(`/app/forms/${id}/responses/${sid}`)).text).toContain('Call back');
  });

  it('marks spam in bulk and shows it in the spam folder', async () => {
    const { id, slug } = await live();
    await respond(id, slug, { q_name: 'Bob', q_email: 'bob@example.com', q_message: 'Hi' });
    const list = (await html(`/app/forms/${id}/responses`)).text;
    const sid = /name="ids" value="([^"]+)"/.exec(list)![1]!;
    await app.request(`/app/forms/${id}/responses/bulk`, { form: { ids: sid, action: 'spam', back: `/app/forms/${id}/responses` }, redirect: 'manual' });
    expect((await html(`/app/forms/${id}/responses?status=spam`)).text).toContain('Bob');
  });

  it('draws the summary empty and with data', async () => {
    const { id, slug } = await live();
    expect((await html(`/app/forms/${id}/summary`)).text).toContain('Nothing to show yet');
    await respond(id, slug, { q_name: 'Cy', q_email: 'cy@example.com', q_message: 'Yo' });
    expect((await html(`/app/forms/${id}/summary`)).text).toContain('Where people drop off');
  });

  it('shows the share link, embed code and the first response check', async () => {
    const { id } = await live();
    const text = (await html(`/app/forms/${id}/share`)).text;
    expect(text).toContain('data-toolshed-form=');
    expect(text).toContain('Waiting for the first response');
    expect(text).toContain('Email is not set up');
  });

  it('saves settings and shows inline errors without saving', async () => {
    const { id } = await live();
    const ok = await app.request(`/app/forms/${id}/settings`, { form: { name: 'Renamed', slug: 'renamed-one', access: 'public', collectMeta: '1' }, redirect: 'manual' });
    expect(ok.status).toBe(303);
    expect((await html(`/app/forms/${id}/settings`)).text).toContain('renamed-one');
    const bad = await app.request(`/app/forms/${id}/settings`, { form: { name: 'Renamed', slug: 'renamed-one', access: 'public', accent: 'red' } });
    expect(bad.status).toBe(422);
    expect(await bad.text()).toContain('six digit colour');
  });

  it('previews and runs a CSV import', async () => {
    const { id } = await live();
    const csv = 'Name,Email,Message\nAda,ada@example.com,Hi\nBo,bo@example.com,Yo\n';
    const prev = await app.request(`/app/forms/${id}/import`, { form: { csv } });
    expect(await prev.text()).toContain('Match the columns');
    const res = await app.request(`/app/forms/${id}/import/run`, { form: { csv, map_0: 'q_name', map_1: 'q_email', map_2: 'q_message' }, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect((await html(`/app/forms/${id}/responses`)).text).toContain('ada@example.com');
  });

  it('finds and deletes everything one person sent', async () => {
    const { id, slug } = await live();
    await respond(id, slug, { q_name: 'Di', q_email: 'di@example.com', q_message: 'x' });
    expect((await html('/app/forms/privacy?email=di@example.com')).text).toContain('Delete all of it');
    await app.request('/app/forms/privacy/delete', { form: { email: 'di@example.com' }, redirect: 'manual' });
    expect((await html('/app/forms/privacy?email=di@example.com')).text).toContain('Nothing found');
  });
});
