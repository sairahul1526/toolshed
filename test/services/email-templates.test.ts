import { describe, expect, it } from 'vitest';
import { EMAIL_LANGUAGES, renderEmail, TEMPLATE_NAMES, cleanSubject } from '../../src/core/email-templates';
import type { TemplateData, TemplateName } from '../../src/core/email-templates';
import { setSetting, INSTANCE } from '../../src/core/settings';
import { createTestEnv } from '../helpers/d1';

const HOSTILE = '<script>alert(1)</script>"&\'\r\nBcc: evil@example.com';

const samples: { [K in TemplateName]: TemplateData[K] } = {
  'sign-in-code': { code: '482913', minutes: 10, link: 'https://tools.example.com/sign-in/verify?t=abc' },
  'claim-code': { code: '739104', minutes: 15 },
  invite: { inviterName: 'Maya', workspaceName: 'Northwind', role: 'Member', link: 'https://tools.example.com/invite/inv_1', days: 7 },
  'email-change': { code: '120045', minutes: 10 },
  'new-device': { device: 'Firefox on Windows', ip: '203.0.113.9', time: '2026-11-20 17:41 UTC' },
  test: {},
  'export-ready': { link: 'https://tools.example.com/api/v1/export/exp_1/download', hours: 24 },
  notification: { title: 'Email needs a sending domain', body: 'Sign-in codes go out from a shared address.', link: 'https://tools.example.com/app/email', linkLabel: 'Open Email' },
};

describe('email templates', () => {
  it('lists every template', () => {
    expect([...TEMPLATE_NAMES].sort()).toEqual(Object.keys(samples).sort());
    expect(EMAIL_LANGUAGES).toEqual(['en', 'es']);
  });

  for (const lang of ['en', 'es']) {
    for (const template of TEMPLATE_NAMES) {
      it(`renders ${template} in ${lang}`, async () => {
        const t = createTestEnv();
        const out = await renderEmail(t.env, { template, data: samples[template] as never, lang });
        expect(out.subject.length).toBeGreaterThan(0);
        expect(out.subject).not.toMatch(/[\r\n]/);
        expect(out.subject).not.toMatch(/\d{6}/);
        expect(out.html).toContain(`<html lang="${lang}"`);
        expect(out.text.trim().length).toBeGreaterThan(20);
        expect(out.text).not.toContain('<');
        const code = (samples[template] as { code?: string }).code;
        if (code) {
          expect(out.html).toContain(code);
          expect(out.text).toContain(code);
          expect(out.subject).not.toContain(code);
        }
      });
    }
  }

  it('speaks Spanish when asked and falls back to the install language, then English', async () => {
    const t = createTestEnv();
    const data = samples['claim-code'];
    expect((await renderEmail(t.env, { template: 'claim-code', data, lang: 'es-MX' })).subject).toMatch(/Termina/);
    expect((await renderEmail(t.env, { template: 'claim-code', data, lang: 'xx' })).subject).toMatch(/Finish/);
    await setSetting(t.env, INSTANCE, 'language', 'es');
    expect((await renderEmail(t.env, { template: 'claim-code', data })).subject).toMatch(/Termina/);
    expect((await renderEmail(t.env, { template: 'claim-code', data, lang: 'en' })).subject).toMatch(/Finish/);
  });

  it('escapes hostile text and keeps subjects on one line', async () => {
    const t = createTestEnv();
    const inv = await renderEmail(t.env, {
      template: 'invite',
      data: { inviterName: HOSTILE, workspaceName: HOSTILE, role: HOSTILE, link: 'https://tools.example.com/i', days: 1 },
    });
    expect(inv.html).not.toContain('<script>');
    expect(inv.html).toContain('&lt;script&gt;');
    expect(inv.subject).not.toMatch(/[\r\n]/);
    const note = await renderEmail(t.env, { template: 'notification', data: { title: HOSTILE, body: HOSTILE } });
    expect(note.subject).not.toMatch(/[\r\n]/);
    expect(note.html).not.toContain('<script>');
    expect(cleanSubject('a\r\nb c')).toBe('a b c');
  });

  it('refuses links that are not web addresses', async () => {
    const t = createTestEnv();
    await expect(renderEmail(t.env, { template: 'export-ready', data: { link: 'javascript:alert(1)', hours: 24 } })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(renderEmail(t.env, { template: 'export-ready', data: { link: 'not a url', hours: 24 } })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('labels the sign-in link and shows the code on its own line in the text part', async () => {
    const t = createTestEnv();
    const out = await renderEmail(t.env, { template: 'sign-in-code', data: samples['sign-in-code'] });
    expect(out.text).toMatch(/\n {4}482913\n/);
    expect(out.text).toMatch(/without typing the code/);
    expect(out.html).toContain('without typing the code');
    expect(out.html).toContain('https://tools.example.com/sign-in/verify?t=abc');
  });

  it('uses the sender name, workspace accent and logo, and ignores unsafe ones', async () => {
    const t = createTestEnv();
    await setSetting(t.env, INSTANCE, 'email.sender', { fromAddress: 'hi@example.com', fromName: 'Northwind Studio' });
    await setSetting(t.env, t.org.id, 'appearance', { accent: '#112233', logoUrl: 'https://cdn.example.com/logo.png' });
    const out = await renderEmail(t.env, { template: 'test', data: {}, orgId: t.org.id });
    expect(out.subject).toBe('Test email from Northwind Studio');
    expect(out.html).toContain('#112233');
    expect(out.html).toContain('https://cdn.example.com/logo.png');

    await setSetting(t.env, t.org.id, 'appearance', { accent: 'red;"', logoUrl: 'javascript:alert(1)' });
    const safe = await renderEmail(t.env, { template: 'test', data: {}, orgId: t.org.id });
    expect(safe.html).not.toContain('javascript:');
    expect(safe.html).not.toContain('red;');
    expect(safe.html).not.toContain('<img');
  });

  it('pluralises durations', async () => {
    const t = createTestEnv();
    const one = await renderEmail(t.env, { template: 'claim-code', data: { code: '1', minutes: 1 } });
    expect(one.text).toContain('1 minute.');
    const many = await renderEmail(t.env, { template: 'claim-code', data: { code: '1', minutes: 5 } });
    expect(many.text).toContain('5 minutes.');
  });
});
