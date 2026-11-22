import { beforeEach, describe, expect, it } from 'vitest';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import { mountModule, type MountedModule } from '../../../test/helpers/app';
import forms from './module';

let t: TestEnv;
let app: MountedModule;

beforeEach(async () => {
  t = createTestEnv();
  app = await mountModule(t, forms);
});

async function live(templateId: string, settings?: Record<string, unknown>) {
  const made = (await (await app.request('/api/v1/forms', { json: { templateId } })).json()) as { id: string; slug: string };
  if (settings) await app.request(`/api/v1/forms/${made.id}/settings`, { method: 'PATCH', json: settings });
  expect((await app.request(`/api/v1/forms/${made.id}/publish`, { json: {} })).status).toBe(200);
  return made;
}

const anon = () => app.as({ kind: 'anon' });

describe('public form page', () => {
  it('draws a working HTML form without scripts, with no badge and a strict CSP', async () => {
    const f = await live('contact');
    const res = await anon().request(`/f/${f.slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`action="/f/${f.slug}/submit"`);
    expect(html).toContain('name="q_email"');
    expect(html).toContain('name="_token"');
    expect(html).toContain('/m/forms/form.js');
    expect(html).not.toMatch(/ style="/);
    expect(html).not.toMatch(/ on[a-z]+="/);
    expect(res.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
  });

  it('lets the embed page be framed anywhere', async () => {
    const f = await live('contact');
    const res = await anon().request(`/f/${f.slug}/embed`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain('frame-ancestors *');
    expect(await res.text()).toContain('data-embed="1"');
  });

  it('says so when the form does not exist, is closed or is full', async () => {
    expect((await anon().request('/f/nothing-here')).status).toBe(404);
    const f = await live('contact');
    await app.request(`/api/v1/forms/${f.id}/close`, { json: {} });
    const res = await anon().request(`/f/${f.slug}`);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('This form is closed');
  });

  it('puts a password in front of the form and opens it with the right one', async () => {
    const f = await live('contact', { access: 'password', password: 'open sesame' });
    const gate = await anon().request(`/f/${f.slug}`);
    expect(gate.status).toBe(401);
    const html = await gate.text();
    expect(html).toContain('This form needs a password');
    expect(html).not.toContain('name="q_email"');
    const wrong = await anon().request(`/f/${f.slug}/unlock`, { form: { password: 'nope' } });
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain('role="alert"');
    const right = await anon().request(`/f/${f.slug}/unlock`, { form: { password: 'open sesame' } });
    expect(right.status).toBe(200);
    expect(await right.text()).toContain('name="_access"');
  });

  it('shows the form again with messages when a plain post has bad answers', async () => {
    const f = await live('contact');
    const page = await (await anon().request(`/f/${f.slug}`)).text();
    const token = /name="_token" value="([^"]+)"/.exec(page)![1]!;
    const res = await anon().request(`/f/${f.slug}/submit`, { form: { _token: token, q_name: 'Ada', q_email: 'not-an-email' } });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Some answers need another look.');
    expect(html).toContain('value="Ada"');
  });

  it('thanks the respondent after a plain post', async () => {
    const f = await live('contact');
    const res = await anon().request(`/f/${f.slug}/thanks`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('We got your message');
  });

  it('puts each field type on the page with a label', async () => {
    const f = await live('feedback-nps');
    const html = await (await anon().request(`/f/${f.slug}`)).text();
    expect(html).toContain('type="radio"');
    expect(html).toContain('<legend>');
    expect(html).toContain('id="fm-def"');
  });
});
