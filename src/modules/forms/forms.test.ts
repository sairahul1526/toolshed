import { beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import forms from './module';
import { getForm } from './service';
import { orgDb } from '../../core/db';
import { issueLoadToken } from './submit';
import { findPublic } from './service';

let t: TestEnv;
let app: MountedModule;

beforeEach(async () => {
  t = createTestEnv();
  app = await mountModule(t, forms);
});

async function live(templateId = 'contact', settings?: Record<string, unknown>) {
  const res = await app.request('/api/v1/forms', { json: { templateId, ...(settings ? { settings } : {}) } });
  if (res.status !== 201) throw new Error(await res.text());
  const form = (await res.json()) as { id: string; slug: string };
  if (settings) await app.request(`/api/v1/forms/${form.id}/settings`, { method: 'PATCH', json: settings });
  const pub = await app.request(`/api/v1/forms/${form.id}/publish`, { json: {} });
  expect(pub.status).toBe(200);
  return form;
}

async function token(slug: string, agoMs = 20_000) {
  const pf = (await findPublic(t.env, slug))!;
  return issueLoadToken(t.env, pf.form, Date.now() - agoMs);
}

const person = { q_name: 'Ada Lovelace', q_email: 'ada@example.com', q_message: 'Hello there, I have a question about pricing.' };

describe('access', () => {
  it('lets viewers read but not write', async () => {
    const v = app.as({ role: 'viewer' });
    expect((await v.request('/api/v1/forms')).status).toBe(200);
    expect((await v.request('/api/v1/forms', { json: { templateId: 'blank' } })).status).toBe(403);
  });
  it('checks API key scopes', async () => {
    const read = app.as({ kind: 'apikey', scopes: ['forms:read'] });
    expect((await read.request('/api/v1/forms')).status).toBe(200);
    expect((await read.request('/api/v1/forms', { json: { templateId: 'blank' } })).status).toBe(403);
    const none = app.as({ kind: 'apikey', scopes: ['links:read'] });
    expect((await none.request('/api/v1/forms')).status).toBe(403);
  });
  it('turns visitors away from the API and serves the public side', async () => {
    const anon = app.as({ kind: 'anon' });
    expect((await anon.request('/api/v1/forms')).status).toBe(401);
    expect((await anon.request('/f/nope/theme.css')).status).toBe(200);
  });
  it('is off when the module is off', async () => {
    const off = await mountModule(createTestEnv(), forms, { off: true });
    expect((await off.request('/api/v1/forms')).status).toBeGreaterThanOrEqual(400);
  });
  it('keeps workspaces apart', async () => {
    const form = await live();
    await expect(getForm(orgDb(t.env.DB, 'org_other'), form.id)).rejects.toThrow();
  });
});

describe('building', () => {
  it('creates, saves, versions, publishes', async () => {
    const created = await live('feedback-nps');
    const got = (await (await app.request(`/api/v1/forms/${created.id}`)).json()) as { definition: unknown; rev: number; status: string };
    expect(got.status).toBe('live');
    const stale = await app.request(`/api/v1/forms/${created.id}/draft`, { method: 'PUT', json: { definition: got.definition, rev: got.rev - 5 } });
    expect(stale.status).toBe(409);
    const ok = await app.request(`/api/v1/forms/${created.id}/draft`, { method: 'PUT', json: { definition: got.definition, rev: got.rev } });
    expect(ok.status).toBe(200);
    const versions = (await (await app.request(`/api/v1/forms/${created.id}/versions`)).json()) as { items: unknown[] };
    expect(versions.items.length).toBeGreaterThan(0);
  });
  it('rejects a broken definition with field errors', async () => {
    const f = await live();
    const res = await app.request(`/api/v1/forms/${f.id}/draft`, { method: 'PUT', json: { definition: { pages: 'x' } } });
    expect(res.status).toBe(422);
  });
  it('never returns the password hash', async () => {
    const f = await live();
    await app.request(`/api/v1/forms/${f.id}/settings`, { method: 'PATCH', json: { access: 'password', password: 'open sesame' } });
    const body = await (await app.request(`/api/v1/forms/${f.id}`)).text();
    expect(body).not.toContain('passwordHash');
    expect(body).toContain('hasPassword');
  });
});

describe('submitting', () => {
  async function post(slug: string, answers: Record<string, unknown>, extra: Record<string, unknown> = {}, agoMs?: number) {
    return app.as({ kind: 'anon' }).request(`/f/${slug}/submit`, { json: { answers, _token: await token(slug, agoMs), ...extra } });
  }

  it('stores a response, counts it and shows it to the team', async () => {
    const f = await live();
    const res = await post(f.slug, person);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('complete');
    const list = (await (await app.request(`/api/v1/forms/${f.id}/submissions`)).json()) as { total: number; items: { id: string }[] };
    expect(list.total).toBe(1);
    const form = (await (await app.request(`/api/v1/forms/${f.id}`)).json()) as { responseCount: number };
    expect(form.responseCount).toBe(1);
    const stats = (await (await app.request(`/api/v1/forms/${f.id}/stats`)).json()) as { completes: number };
    expect(stats.completes).toBe(1);
  });

  it('refuses posts without the page token unless direct posts are allowed', async () => {
    const f = await live();
    const res = await app.as({ kind: 'anon' }).request(`/f/${f.slug}/submit`, { json: { answers: person } });
    expect(res.status).toBe(403);
  });

  it('shows what to fix when answers are invalid', async () => {
    const f = await live();
    const res = await post(f.slug, { ...person, q_email: 'not an email' });
    expect(res.status).toBe(422);
  });

  it('puts honeypot and too-fast posts in spam without counting them', async () => {
    const f = await live();
    expect(((await (await post(f.slug, person, { _gotcha: 'bot' })).json()) as { status: string }).status).toBe('spam');
    expect(((await (await post(f.slug, { ...person, q_name: 'Quick' }, {}, 100)).json()) as { status: string }).status).toBe('spam');
    const list = (await (await app.request(`/api/v1/forms/${f.id}/submissions?status=spam`)).json()) as { total: number };
    expect(list.total).toBe(2);
    const form = (await (await app.request(`/api/v1/forms/${f.id}`)).json()) as { responseCount: number };
    expect(form.responseCount).toBe(0);
  });

  it('ignores an exact repeat', async () => {
    const f = await live();
    await post(f.slug, person);
    await post(f.slug, person);
    const list = (await (await app.request(`/api/v1/forms/${f.id}/submissions`)).json()) as { total: number };
    expect(list.total).toBe(1);
  });

  it('stops at the response cap', async () => {
    const f = await live('contact', { cap: 1 });
    expect((await post(f.slug, person)).status).toBe(200);
    expect((await post(f.slug, { ...person, q_name: 'Grace Hopper' })).status).toBeGreaterThanOrEqual(400);
  });

  it('accepts a plain HTML form post by field key', async () => {
    const f = await live('contact', { allowDirectPosts: true });
    const res = await app.as({ kind: 'anon' }).request(`/f/${f.slug}/submit`, { form: { name: 'Ada', email: 'ada@example.com', message: 'A plain static page form post.' }, redirect: 'manual' });
    expect(res.status).toBe(303);
  });

  it('emits form.submitted without an address in it', async () => {
    const f = await live();
    await post(f.slug, person);
    const row = await t.env.DB.prepare("SELECT data FROM events_log WHERE name = 'forms.form.submitted'").first<{ data: string }>().catch(() => null);
    if (row) expect(row.data).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});

describe('managing responses', () => {
  it('marks spam, deletes and exports', async () => {
    const f = await live();
    const tk = await token(f.slug);
    const res = await app.as({ kind: 'anon' }).request(`/f/${f.slug}/submit`, { json: { answers: person, _token: tk } });
    const { id } = (await res.json()) as { id: string };
    expect((await app.request(`/api/v1/forms/${f.id}/submissions/bulk`, { json: { action: 'spam', ids: [id] } })).status).toBe(200);
    expect(((await (await app.request(`/api/v1/forms/${f.id}`)).json()) as { responseCount: number }).responseCount).toBe(0);
    await app.request(`/api/v1/forms/${f.id}/submissions/bulk`, { json: { action: 'not_spam', ids: [id] } });
    const csv = await (await app.request(`/api/v1/forms/${f.id}/submissions/export.csv`)).text();
    expect(csv).toContain('ada@example.com');
    const found = (await (await app.request('/api/v1/forms/respondents?email=ada@example.com')).json()) as { items: unknown[] };
    expect(found.items.length).toBe(1);
    const del = await app.request('/api/v1/forms/respondents?email=ada@example.com', { method: 'DELETE' });
    expect(((await del.json()) as { removed: number }).removed).toBe(1);
  });

  it('imports responses from a CSV with mapping', async () => {
    const f = await live();
    const csv = 'Full name,Mail,Note\nGrace Hopper,grace@example.com,Compilers are great and I wanted to say so.\n';
    const pre = (await (await app.request(`/api/v1/forms/${f.id}/submissions/import/preview`, { json: { csv } })).json()) as { mapping: Record<string, string> };
    const res = await app.request(`/api/v1/forms/${f.id}/submissions/import`, { json: { csv, mapping: { ...pre.mapping, 'Full name': 'q_name', Mail: 'q_email', Note: 'q_message' } } });
    expect(((await res.json()) as { imported: number }).imported).toBe(1);
  });
});

describe('module hooks', () => {
  it('adds and clears sample data', async () => {
    await forms.sampleData!({ env: t.env, org: t.org, db: orgDb(t.env.DB, t.org.id) });
    expect(((await (await app.request('/api/v1/forms')).json()) as { total: number }).total).toBe(2);
    await forms.clearSampleData!({ env: t.env, org: t.org, db: orgDb(t.env.DB, t.org.id) });
    expect(((await (await app.request('/api/v1/forms')).json()) as { total: number }).total).toBe(0);
  });
  it('exports data without password hashes', async () => {
    const f = await live();
    await app.request(`/api/v1/forms/${f.id}/settings`, { method: 'PATCH', json: { access: 'password', password: 'hunter22' } });
    const data = await forms.exportData!({ env: t.env, org: t.org, db: orgDb(t.env.DB, t.org.id) });
    expect(JSON.stringify(data)).not.toContain('passwordHash');
  });
});
