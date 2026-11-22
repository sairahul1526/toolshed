import { describe, expect, it } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { mountModule } from '../../../test/helpers/app';
import mod from './module';

async function setup() {
  const t = createTestEnv();
  const app = await mountModule(t, mod);
  return { t, app };
}

async function make(app: Awaited<ReturnType<typeof setup>>['app'], extra: Record<string, unknown> = {}) {
  const res = await app.request('/api/v1/waitlist/waitlists', { json: { name: 'Launch', status: 'live', double_optin: false, fraud_level: 'off', ...extra } });
  return (await res.json()) as { id: string; slug: string };
}

describe('dashboard', () => {
  it('shows an empty state with the sample data button', async () => {
    const { app } = await setup();
    const res = await app.request('/app/waitlist');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('No waitlists yet');
    expect(html).toContain('Try it with sample data');
    expect(html).toContain('/m/waitlist/waitlist.css');
  });

  it('creates a waitlist from the form and lands in the editor', async () => {
    const { app } = await setup();
    const res = await app.request('/app/waitlist/new', { form: { name: 'Beta' }, redirect: 'manual' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/app/waitlist/edit?w=');
  });

  it('keeps people with a viewer role from changing things', async () => {
    const { app } = await setup();
    const res = await app.as({ role: 'viewer' }).request('/app/waitlist/new', { form: { name: 'Nope' }, redirect: 'manual' });
    expect(res.status).toBe(403);
  });

  it('adds and clears sample data', async () => {
    const { app } = await setup();
    await app.request('/app/waitlist/sample', { method: 'POST', redirect: 'manual' });
    const list = await (await app.request('/app/waitlist')).text();
    expect(list).toContain('sample');
    const people = await (await app.request('/app/waitlist/people')).text();
    expect(people).toContain('example.com');
  });

  it('renders every screen for a waitlist with people', async () => {
    const { app } = await setup();
    const wl = await make(app);
    const visitor = app.as({ kind: 'anon' });
    for (const email of ['a@example.com', 'b@example.com']) {
      const r = await visitor.request(`/w/${wl.slug}/join`, { json: { email } });
      expect(r.status).toBe(201);
    }
    for (const path of ['people', 'review', 'launch', 'stats', 'edit', 'data']) {
      const res = await app.request(`/app/waitlist/${path}?w=${wl.id}`);
      expect(res.status, path).toBe(200);
    }
    const people = await (await app.request(`/app/waitlist/people?w=${wl.id}&q=a@example`)).text();
    expect(people).toContain('a@example.com');
    expect(people).not.toContain('b@example.com');
  });

  it('shows inline errors when the editor form is invalid', async () => {
    const { app } = await setup();
    const wl = await make(app);
    const res = await app.request(`/app/waitlist/edit?w=${wl.id}`, { form: { name: '', slug: 'ok' } });
    expect(res.status).toBe(422);
  });

  it('imports a pasted csv after mapping columns', async () => {
    const { app, t } = await setup();
    const wl = await make(app);
    const csv = 'email,name\nnew@example.com,New One\nbad,Nobody\n';
    const preview = await app.request(`/app/waitlist/data/import?w=${wl.id}`, { form: { csv } });
    expect(await preview.text()).toContain('Match your columns');
    const done = await app.request(`/app/waitlist/data/import?w=${wl.id}`, { form: { csv, confirm: 'yes', m_email: '0', m_name: '1' }, redirect: 'manual' });
    expect(done.status).toBe(303);
    const row = await t.env.DB.prepare("SELECT name FROM wl_signups WHERE email = 'new@example.com'").first<{ name: string }>();
    expect(row?.name).toBe('New One');
  });

  it('erases a person by email', async () => {
    const { app, t } = await setup();
    const wl = await make(app);
    await app.as({ kind: 'anon' }).request(`/w/${wl.slug}/join`, { json: { email: 'gone@example.com' } });
    await app.request(`/app/waitlist/data/erase?w=${wl.id}`, { form: { email: 'gone@example.com' }, redirect: 'manual' });
    const row = await t.env.DB.prepare("SELECT id FROM wl_signups WHERE email = 'gone@example.com'").first();
    expect(row).toBeNull();
  });
});
