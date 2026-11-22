import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import appearance from '../../src/dashboard/appearance';
import overview from '../../src/dashboard/overview';
import { resolveBrand } from '../../src/core/email-templates/brand';
import { getSetting, setSetting } from '../../src/core/settings';
import { ACCENTS, MODES, PUBLIC_PRESETS } from '../../src/ui/appearance';
import { createTestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const app = createApp({ screens: { overview, appearance } });

let t: TestEnv;
beforeEach(() => {
  t = createTestEnv();
});

async function post(headers: Record<string, string>, path: string, fields: Record<string, string>): Promise<Response> {
  return app.request(path, { method: 'POST', headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }, t.env);
}

const full = { mode: 'system', accent: 'lime', preset: 'paper', powered: 'on', logoUrl: '' };
const saveForm = (headers: Record<string, string>, over: Record<string, string> = {}) => post(headers, '/app/appearance', { ...full, ...over });
const saved = (orgId = 'org_test') => getSetting<Record<string, unknown>>(t.env, orgId, 'appearance', {});
const auditRows = async (orgId = 'org_test') =>
  (await t.env.DB.prepare("SELECT action, meta, summary FROM audit_log WHERE org_id = ?1 AND action LIKE 'appearance.%' ORDER BY rowid").bind(orgId).all<{ action: string; meta: string; summary: string }>()).results;

describe('who can open it', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const res = await app.request('/app/appearance', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it.each(['owner', 'admin'] as const)('lets a %s change things', async (role) => {
    const { headers } = await createTestSession(t.env, { role });
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('Save appearance');
    expect(html).toContain('Reset to defaults');
    expect(html).not.toContain('You can look, not change');
  });

  it.each(['member', 'viewer'] as const)('shows a %s the screen read-only and refuses their posts', async (role) => {
    const { headers } = await createTestSession(t.env, { role });
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('You can look, not change');
    expect(html).not.toContain('Save appearance');
    expect(html).not.toContain('Reset to defaults');
    expect(html).toContain('disabled');
    expect((await saveForm(headers, { accent: 'rose' })).status).toBe(403);
    expect((await post(headers, '/app/appearance/reset', {})).status).toBe(403);
    expect(await saved()).toEqual({});
  });
});

describe('saving', () => {
  it.each(MODES)('saves mode %s and shows it selected', async (mode) => {
    const { headers } = await createTestSession(t.env);
    const res = await saveForm(headers, { mode });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/appearance');
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toMatch(new RegExp(`name="mode" value="${mode}" checked`));
  });

  it.each(ACCENTS)('saves accent %s and shows it selected', async (accent) => {
    const { headers } = await createTestSession(t.env);
    expect((await saveForm(headers, { accent })).status).toBe(303);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toMatch(new RegExp(`name="accent" value="${accent}" checked`));
    expect(html).toContain(`data-accent="${accent}"`);
  });

  it.each(PUBLIC_PRESETS)('saves preset %s and shows it selected', async (preset) => {
    const { headers } = await createTestSession(t.env);
    expect((await saveForm(headers, { preset })).status).toBe(303);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toMatch(new RegExp(`name="preset" value="${preset}" checked`));
  });

  it('saves the Powered by Toolshed switch both ways', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { powered: 'off' });
    expect((await saved()).powered).toBe(false);
    let html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).not.toMatch(/name="powered" value="on" checked/);
    expect(html).toContain('without the Powered by Toolshed line');
    await saveForm(headers, { powered: 'on' });
    expect((await saved()).powered).toBe(true);
    html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toMatch(/name="powered" value="on" checked/);
  });

  it('shows a saved look on another screen', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { mode: 'dark', accent: 'violet' });
    const html = await (await app.request('/app', { headers }, t.env)).text();
    expect(html).toContain('data-accent="violet"');
    expect(html).toContain('data-mode="dark"');
  });

  it('keeps the form fields filled with the saved values', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { logoUrl: 'https://example.com/logo.png' });
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('value="https://example.com/logo.png"');
  });

  it('does not write or audit when nothing changed', async () => {
    const { headers } = await createTestSession(t.env);
    expect((await saveForm(headers)).status).toBe(303);
    expect(await saved()).toEqual({});
    expect(await auditRows()).toHaveLength(0);
  });

  it('keeps other keys already in the setting', async () => {
    await setSetting(t.env, 'org_test', 'appearance', { accent: 'lime', somethingElse: 'kept' });
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { accent: 'sky' });
    expect(await saved()).toMatchObject({ accent: 'sky', somethingElse: 'kept' });
  });

  it('leaves a field alone when the post does not mention it', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { mode: 'dark', accent: 'rose' });
    await post(headers, '/app/appearance', { preset: 'cobalt' });
    expect(await saved()).toMatchObject({ mode: 'dark', accent: 'rose', preset: 'cobalt' });
  });
});

describe('bad values', () => {
  it.each([
    ['mode', 'neon'],
    ['accent', '#ff0000'],
    ['preset', 'glitter'],
    ['powered', 'maybe'],
  ])('rejects %s=%s with 422 and saves nothing', async (field, value) => {
    const { headers } = await createTestSession(t.env);
    const res = await saveForm(headers, { accent: 'sky', [field]: value });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('Nothing was saved');
    expect(html).toContain('Pick one of the options shown.');
    expect(await saved()).toEqual({});
    expect(await auditRows()).toHaveLength(0);
  });

  it('shows the saved choice selected again after a rejected post', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { accent: 'amber' });
    const html = await (await saveForm(headers, { accent: 'amber', mode: 'neon' })).text();
    expect(html).toMatch(/name="accent" value="amber" checked/);
    expect(html).toMatch(/name="mode" value="system" checked/);
  });
});

describe('logo address', () => {
  it('saves a public https address and uses it in emails', async () => {
    const { headers } = await createTestSession(t.env);
    expect((await saveForm(headers, { logoUrl: '  https://cdn.example.com/brand/logo.png  ' })).status).toBe(303);
    expect((await saved()).logoUrl).toBe('https://cdn.example.com/brand/logo.png');
    expect((await resolveBrand(t.env, 'org_test')).logoUrl).toBe('https://cdn.example.com/brand/logo.png');
  });

  it.each([
    ['http://example.com/logo.png', 'https://'],
    ['https://10.0.0.1/logo.png', 'public web address'],
    ['https://192.168.1.5/logo.png', 'public web address'],
    ['https://localhost/logo.png', 'public web address'],
    ['https://[::1]/logo.png', 'public web address'],
    ['javascript:alert(1)', 'public web address'],
    ['data:image/png;base64,AAAA', 'public web address'],
    ['https://user:pass@example.com/logo.png', 'public web address'],
    ['not a url', 'public web address'],
    [`https://example.com/${'a'.repeat(2100)}`, 'too long'],
  ])('rejects %s', async (logoUrl, message) => {
    const { headers } = await createTestSession(t.env);
    const res = await saveForm(headers, { logoUrl, accent: 'sky' });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain(message);
    expect(await saved()).toEqual({});
  });

  it('keeps what was typed in the field after a rejected address', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await saveForm(headers, { logoUrl: 'http://example.com/<b>x</b>.png' })).text();
    expect(html).toContain('value="http://example.com/&lt;b&gt;x&lt;/b&gt;.png"');
    expect(html).toContain('aria-invalid="true"');
  });

  it('removes the logo when the field is emptied', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { logoUrl: 'https://example.com/logo.png' });
    await saveForm(headers, { logoUrl: '' });
    expect(await saved()).not.toHaveProperty('logoUrl');
    expect((await resolveBrand(t.env, 'org_test')).logoUrl).toBeNull();
  });

  it('never loads the logo from another site into the page', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { logoUrl: 'https://cdn.example.com/logo.png' });
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).not.toMatch(/<img[^>]+cdn\.example\.com/);
    expect(html).toContain('Saved logo address: https://cdn.example.com/logo.png');
  });
});

describe('reset', () => {
  it('goes back to the defaults and removes the logo', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { mode: 'dark', accent: 'rose', preset: 'dusk', powered: 'off', logoUrl: 'https://example.com/logo.png' });
    const res = await post(headers, '/app/appearance/reset', {});
    expect(res.status).toBe(303);
    expect(await saved()).toEqual({});
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toMatch(/name="mode" value="system" checked/);
    expect(html).toMatch(/name="accent" value="lime" checked/);
    expect(html).toMatch(/name="preset" value="paper" checked/);
    expect(html).toMatch(/name="powered" value="on" checked/);
    expect(html).toContain('No logo address saved');
  });

  it('asks first, naming what is lost', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('Reset to the Toolshed defaults?');
    expect(html).toContain('the logo address is removed');
  });

  it('does nothing and audits nothing when already on defaults', async () => {
    const { headers } = await createTestSession(t.env);
    expect((await post(headers, '/app/appearance/reset', {})).status).toBe(303);
    expect(await auditRows()).toHaveLength(0);
  });
});

describe('audit', () => {
  it('writes appearance.updated with only the keys that changed', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { accent: 'sky', preset: 'warm' });
    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.action).toBe('appearance.updated');
    expect(JSON.parse(rows[0]!.meta)).toEqual({ changed: ['accent', 'preset'] });
    expect(rows[0]!.summary).toBe('Changed the appearance: accent colour, public page look');
  });

  it('marks a reset', async () => {
    const { headers } = await createTestSession(t.env);
    await saveForm(headers, { accent: 'sky' });
    await post(headers, '/app/appearance/reset', {});
    const rows = await auditRows();
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!.meta)).toEqual({ changed: ['accent'], reset: true });
  });
});

describe('workspaces are separate', () => {
  it('does not change another workspace', async () => {
    const mine = await createTestSession(t.env);
    const other = await createTestSession(t.env, { orgId: 'org_other' });
    await saveForm(mine.headers, { accent: 'rose', logoUrl: 'https://example.com/mine.png' });
    expect(await saved('org_other')).toEqual({});
    const html = await (await app.request('/app', { headers: other.headers }, t.env)).text();
    expect(html).toContain('data-accent="lime"');
    await saveForm(other.headers, { accent: 'amber' });
    expect((await saved()).accent).toBe('rose');
    expect((await saved('org_other')).accent).toBe('amber');
    await post(other.headers, '/app/appearance/reset', {});
    expect((await saved()).accent).toBe('rose');
    expect(await auditRows('org_other')).toHaveLength(2);
    expect(await auditRows()).toHaveLength(1);
  });
});

describe('worst-case text', () => {
  it('escapes the workspace name and a long one does not break the page', async () => {
    const name = `<script>alert(1)</script>${'W'.repeat(300)}`;
    const { headers } = await createTestSession(t.env, { orgId: 'org_evil' });
    await t.env.DB.prepare('UPDATE "organization" SET "name" = ?1 WHERE "id" = ?2').bind(name, 'org_evil').run();
    const res = await app.request('/app/appearance', { headers }, t.env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('shows non-Latin workspace names', async () => {
    const { headers } = await createTestSession(t.env, { orgId: 'org_jp' });
    await t.env.DB.prepare('UPDATE "organization" SET "name" = ?1 WHERE "id" = ?2').bind('株式会社テスト', 'org_jp').run();
    expect(await (await app.request('/app/appearance', { headers }, t.env)).text()).toContain('株式会社テスト');
  });
});

describe('page content', () => {
  it('names every accent in text, not just colour', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    for (const name of ['Lime', 'Mint', 'Sky', 'Violet', 'Rose', 'Amber', 'Paper', 'Warm', 'Cobalt', 'Dusk', 'System', 'Light', 'Dark']) expect(html).toContain(`<b>${name}</b>`);
  });

  it('explains the workspace default versus a personal choice', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('workspace default');
    expect(html).toContain('just for themselves');
  });

  it('shows the preview in both light and dark for system mode and one for a fixed mode', async () => {
    const { headers } = await createTestSession(t.env);
    let html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).toContain('Dashboard in light mode');
    expect(html).toContain('Dashboard in dark mode');
    await saveForm(headers, { mode: 'dark' });
    html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).not.toContain('Dashboard in light mode');
    expect(html).toContain('Dashboard in dark mode');
  });

  it('uses no inline styles or handlers', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await app.request('/app/appearance', { headers }, t.env)).text();
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/);
  });
});
