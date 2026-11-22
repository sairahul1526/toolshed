import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app';
import { audit, getAuditRetention, AUDIT_EXPORT_LIMIT, type AuditEntry } from '../../src/core/audit';
import screen from '../../src/dashboard/audit-log';
import type { Env, Role } from '../../src/env';
import { countQueries, createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const NOW = Date.UTC(2026, 10, 20, 18, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;
const OTHER = 'org_other';

let t: TestEnv;
const app = () => createApp({ screens: { 'audit-log': screen } });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  t = createTestEnv();
});
afterEach(() => vi.useRealTimers());

/** `audit()` stamps the clock, so each entry is written at a chosen moment and the clock is put back. */
async function seed(at: number, entry: AuditEntry): Promise<void> {
  vi.setSystemTime(at);
  await audit(t.env as Env, { orgId: t.org.id, actorId: 'usr_maya', actorLabel: 'maya@example.com', ...entry });
  vi.setSystemTime(NOW);
}

const get = async (path: string, s: TestSession, headers: Record<string, string> = {}) => app().request(path, { headers: { ...s.headers, ...headers } }, t.env);
const ids = (html: string) => [...html.matchAll(/aud_[0-9a-z]{22}/g)].map((m) => m[0]);
const post = async (path: string, s: TestSession, body: Record<string, string>) =>
  app().request(path, { method: 'POST', headers: { ...s.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() }, t.env);

async function session(role: Role, extra: { instanceOwner?: boolean; orgId?: string; email?: string } = {}) {
  return createTestSession(t.env, { role, ...extra });
}

describe('who can open the audit log', () => {
  it('lets owners and admins in', async () => {
    for (const role of ['owner', 'admin'] as const) {
      const res = await get('/app/audit-log', await session(role));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('Audit log');
    }
  });

  it('shows members and viewers the forbidden page', async () => {
    for (const role of ['member', 'viewer'] as const) {
      const res = await get('/app/audit-log', await session(role), { accept: 'text/html' });
      expect(res.status).toBe(403);
      expect(await res.text()).toContain('Only workspace admins can do that');
    }
  });

  it('sends signed-out browsers to sign-in', async () => {
    const res = await app().request('/app/audit-log?q=x', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/sign-in?next=${encodeURIComponent('/app/audit-log?q=x')}`);
  });

  it('keeps the export and retention for admins and the owner only', async () => {
    const member = await session('member');
    expect((await get('/app/audit-log/export.csv', member)).status).toBe(403);
    expect((await post('/app/audit-log/retention', member, { retention: '30' })).status).toBe(403);
  });
});

describe('the list', () => {
  it('shows entries newest first with a relative time, the exact time and a readable sentence', async () => {
    await seed(NOW - 3 * DAY, { action: 'module.disabled', targetType: 'module', targetId: 'forms', summary: 'Turned off Forms', ip: '203.0.113.9' });
    await seed(NOW - 5 * MIN, { action: 'module.enabled', targetType: 'module', targetId: 'links', summary: 'Turned on Links', ip: '203.0.113.7' });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html.indexOf('Turned on Links')).toBeGreaterThan(-1);
    expect(html.indexOf('Turned on Links')).toBeLessThan(html.indexOf('Turned off Forms'));
    expect(html).toContain('5 minutes ago');
    expect(html).toContain('3 days ago');
    expect(html).toContain(`datetime="${new Date(NOW - 5 * MIN).toISOString()}"`);
    expect(html).toContain('title="Nov 20, 2026, 5:55 PM UTC"');
    expect(html).toContain('203.0.113.7');
    expect(html).toContain('maya@example.com');
  });

  it('shows the raw code for an action it does not know, and names API keys and automatic entries', async () => {
    await seed(NOW - 3 * MIN, { action: 'widget.exploded', summary: 'Went bang' });
    await seed(NOW - 2 * MIN, { action: 'api_key.created', actorType: 'apikey', actorId: 'key_1', actorLabel: null });
    await seed(NOW - 1 * MIN, { action: 'user.sign_in_paused', actorType: 'system', actorId: null, actorLabel: null });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html).toContain('widget.exploded');
    expect(html).toContain('Went bang');
    expect(html).toContain('An API key');
    expect(html).toContain('Made an API key');
    expect(html).toContain('Toolshed');
    expect(html).toContain('Automatic');
  });

  it('expands a row into a readable list, never raw JSON', async () => {
    await seed(NOW - MIN, {
      action: 'member.role_changed',
      targetType: 'user',
      targetId: 'usr_priya',
      meta: { from_role: 'member', to: 'admin', sent: true, codes: ['a', 'b'], nested: { deeper: { count: 3 } }, nothing: null },
    });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html).toContain('<details>');
    for (const text of ['From role', 'member', 'Yes', 'a, b', 'Deeper', 'None', 'Action code', 'member.role_changed', 'Entry']) expect(html).toContain(text);
    expect(html).not.toMatch(/&quot;from_role&quot;|"from_role"|\{&quot;|\{"/);
  });

  it('shows an empty state with a next step when nothing is recorded, and a different one when a filter matches nothing', async () => {
    const admin = await session('admin');
    const empty = await (await get('/app/audit-log', admin)).text();
    expect(empty).toContain('<h3>Nothing has been recorded yet</h3>');
    expect(empty).not.toContain('<h3>Nothing matches</h3>');

    await seed(NOW - MIN, { action: 'user.signed_in' });
    const none = await (await get('/app/audit-log?q=zzzz', admin)).text();
    expect(none).toContain('<h3>Nothing matches</h3>');
    expect(none).toContain('Clear filters');
    expect(none).not.toContain('<h3>Nothing has been recorded yet</h3>');
  });

  it('stays within a handful of audit queries', async () => {
    await seed(NOW - MIN, { action: 'user.signed_in' });
    const admin = await session('admin');
    const { queries } = await countQueries(t.env as Env, () => get('/app/audit-log', admin));
    expect(queries.filter((q) => q.includes('audit_log')).length).toBeLessThanOrEqual(3);
  });
});

describe('filters', () => {
  beforeEach(async () => {
    await seed(NOW - 10 * DAY, { action: 'api_key.created', actorId: 'usr_jonas', actorLabel: 'jonas@example.com', summary: 'Made the key Zapier' });
    await seed(NOW - 5 * DAY, { action: 'member.invited', actorId: 'usr_maya', summary: 'Invited aiko@example.com as Member' });
    await seed(NOW - 2 * DAY, { action: 'api_key.revoked', actorId: 'usr_maya', summary: 'Revoked the key Zapier' });
    await seed(NOW - 1 * DAY, { action: 'member.role_changed', actorId: 'usr_jonas', actorLabel: 'jonas@example.com', summary: 'Changed Priya to Admin' });
  });

  const shown = async (query: string) => {
    const res = await get(`/app/audit-log${query}`, await session('admin'));
    const html = await res.text();
    return { res, html, actions: ['api_key.created', 'member.invited', 'api_key.revoked', 'member.role_changed'].filter((a) => html.includes(`<code class="mono">${a}</code>`)) };
  };

  it('filters by person', async () => {
    expect((await shown('?actor=usr_jonas')).actions).toEqual(['api_key.created', 'member.role_changed']);
  });

  it('filters by action', async () => {
    expect((await shown('?action=api_key.revoked')).actions).toEqual(['api_key.revoked']);
  });

  it('filters by words in the summary, the person or the action', async () => {
    expect((await shown('?q=zapier')).actions).toEqual(['api_key.created', 'api_key.revoked']);
    expect((await shown('?q=jonas')).actions).toEqual(['api_key.created', 'member.role_changed']);
    expect((await shown('?q=role_changed')).actions).toEqual(['member.role_changed']);
  });

  it('treats % and _ in a search as plain text', async () => {
    expect((await shown('?q=%25')).actions).toEqual([]);
    expect((await shown('?q=api_k_y')).actions).toEqual([]);
  });

  it('filters by date range, including the whole last day', async () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    expect((await shown(`?from=${day(NOW - 5 * DAY)}`)).actions).toEqual(['member.invited', 'api_key.revoked', 'member.role_changed']);
    expect((await shown(`?to=${day(NOW - 5 * DAY)}`)).actions).toEqual(['api_key.created', 'member.invited']);
    expect((await shown(`?from=${day(NOW - 5 * DAY)}&to=${day(NOW - 2 * DAY)}`)).actions).toEqual(['member.invited', 'api_key.revoked']);
  });

  it('combines every filter', async () => {
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const q = `?actor=usr_maya&action=api_key.revoked&q=zapier&from=${day(NOW - 3 * DAY)}&to=${day(NOW)}`;
    expect((await shown(q)).actions).toEqual(['api_key.revoked']);
    expect((await shown(`?actor=usr_jonas&action=api_key.revoked`)).actions).toEqual([]);
  });

  it('keeps the filters in the form and offers Clear filters', async () => {
    const { html } = await shown('?actor=usr_jonas&q=zapier&from=2026-11-01&to=2026-11-30');
    expect(html).toContain('value="zapier"');
    expect(html).toContain('value="2026-11-01"');
    expect(html).toContain('value="2026-11-30"');
    expect(html).toMatch(/<option value="usr_jonas" selected/);
    expect(html).toContain('Clear filters');
    expect((await shown('')).html).not.toContain('Clear filters');
  });

  it('fills the menus from the log, grouped by kind', async () => {
    const { html } = await shown('');
    expect(html).toContain('<optgroup label="API keys">');
    expect(html).toContain('<optgroup label="Members">');
    expect(html).toContain('Made an API key');
    expect(html).toContain('jonas@example.com');
  });

  it('explains a bad date or range next to the filters with a 422', async () => {
    for (const [query, message] of [
      ['?from=2026-02-31', 'That start date doesn’t exist.'],
      ['?to=yesterday', 'The end date must be a date like 2026-11-20.'],
      ['?from=2026-11-20&to=2026-11-01', 'The end date is before the start date.'],
      [`?q=${'x'.repeat(101)}`, 'The search can be up to 100 characters.'],
    ] as const) {
      const res = await shown(query);
      expect(res.res.status).toBe(422);
      expect(res.html).toContain(message);
      expect(res.html).not.toContain('href="/app/audit-log/export.csv');
    }
  });

  it('refuses a page marker that is not one of ours', async () => {
    expect((await get('/app/audit-log?before=not-a-cursor', await session('admin'), { accept: 'text/html' })).status).toBe(400);
  });

  it('escapes what was typed into the filters', async () => {
    const { html } = await shown(`?q=${encodeURIComponent('"><script>alert(1)</script>')}`);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('pages by cursor', () => {
  it('walks every entry once, newest first, across ties on the same millisecond', async () => {
    // 3 moments, 40 entries each: every page boundary lands inside a tie at some point.
    for (let m = 0; m < 3; m++) for (let i = 0; i < 40; i++) await seed(NOW - (3 - m) * DAY, { action: 'user.signed_in', summary: `entry ${m}-${i}` });
    const admin = await session('admin');

    const seen: string[] = [];
    let path: string | null = '/app/audit-log';
    let pages = 0;
    while (path) {
      const html = await (await get(path, admin)).text();
      seen.push(...ids(html));
      pages++;
      const next: string | undefined = html.match(/<a class="btn sm" href="([^"]+)" rel="next"/)?.[1];
      path = next ? next.replace(/&amp;/g, '&') : null;
      expect(pages).toBeLessThan(10);
    }
    const expected = (t.sqlite.prepare("SELECT id FROM audit_log WHERE org_id = 'org_test' ORDER BY created_at DESC, id DESC").all() as { id: string }[]).map((r) => r.id);
    expect(pages).toBe(3);
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(120);
  });

  it('keeps the filters when loading older entries, and links back to the newest', async () => {
    for (let i = 0; i < 60; i++) await seed(NOW - (i + 1) * MIN, { action: 'api_key.created' });
    for (let i = 0; i < 5; i++) await seed(NOW - (i + 1) * MIN, { action: 'user.signed_in' });
    const admin = await session('admin');
    const first = await (await get('/app/audit-log?action=api_key.created', admin)).text();
    expect(first).toContain('Newest entries');
    const next = first.match(/href="([^"]+)" rel="next"/)![1]!.replace(/&amp;/g, '&');
    expect(next).toContain('action=api_key.created');
    expect(next).toContain('before=');
    const second = await (await get(next, admin)).text();
    expect(ids(second)).toHaveLength(10);
    expect(second).toContain('Older entries');
    expect(second).toContain('Back to newest');
    expect(second).toContain('That is everything.');
    expect(second).not.toContain('user.signed_in</code>');
  });
});

describe('workspaces', () => {
  beforeEach(async () => {
    await seed(NOW - 3 * MIN, { action: 'module.enabled', targetId: 'links', summary: 'MINE' });
    await seed(NOW - 2 * MIN, { orgId: OTHER, action: 'module.enabled', targetId: 'forms', summary: 'THEIRS', actorId: 'usr_stranger', actorLabel: 'stranger@example.com' });
    await seed(NOW - 1 * MIN, { orgId: null, action: 'user.signed_in', summary: 'INSTALL', actorId: 'usr_stranger', actorLabel: 'stranger@example.com' });
  });

  it('shows a workspace only its own entries, filters and menus', async () => {
    const html = await (await get('/app/audit-log', await session('owner'))).text();
    expect(html).toContain('Turned on Links');
    for (const leak of ['THEIRS', 'INSTALL', 'Turned on Forms', 'stranger@example.com', 'usr_stranger']) expect(html).not.toContain(leak);
    // Filters cannot reach across either.
    const asked = await (await get('/app/audit-log?actor=usr_stranger', await session('owner'))).text();
    expect(asked).toContain('<h3>Nothing matches</h3>');
    expect(asked).not.toContain('THEIRS');
  });

  it('shows the other workspace its own entries', async () => {
    const html = await (await get('/app/audit-log', await session('admin', { orgId: OTHER, email: 'other@example.com' }))).text();
    expect(html).toContain('Turned on Forms');
    expect(html).not.toContain('MINE');
  });

  it('keeps the whole-install view for the instance owner', async () => {
    const admin = await session('admin');
    expect((await get('/app/audit-log?scope=all', admin, { accept: 'text/html' })).status).toBe(403);
    expect(await (await get('/app/audit-log', admin)).text()).not.toContain('Whole install');

    const owner = await session('owner', { instanceOwner: true, email: 'boss@example.com' });
    const page = await (await get('/app/audit-log', owner)).text();
    expect(page).toContain('Whole install');
    expect(page).not.toContain('INSTALL');
    const all = await (await get('/app/audit-log?scope=all', owner)).text();
    for (const text of ['MINE', 'THEIRS', 'INSTALL']) expect(all).toContain(text);
  });
});

describe('export', () => {
  it('sends a dated CSV download of the current filter', async () => {
    await seed(NOW - 2 * MIN, { action: 'api_key.created', actorLabel: 'jonas@example.com', summary: 'Made the key Zapier', targetType: 'api_key', targetId: 'key_1', ip: '203.0.113.7' });
    await seed(NOW - 1 * MIN, { action: 'member.invited', summary: 'Invited aiko@example.com' });
    await seed(NOW - 1 * MIN, { orgId: OTHER, action: 'member.invited', summary: 'THEIRS' });
    const res = await get('/app/audit-log/export.csv?action=api_key.created', await session('admin'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="audit-log-2026-11-20.csv"');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('When (UTC),Workspace,Who,Kind,Action,What happened,Target type,Target,IP address');
    expect(lines[1]).toBe('2026-11-20T17:58:00.000Z,org_test,jonas@example.com,user,api_key.created,Made the key Zapier,api_key,key_1,203.0.113.7');
  });

  it('never exports another workspace, and keeps the whole install for its owner', async () => {
    await seed(NOW - 3 * MIN, { action: 'module.enabled', summary: 'MINE' });
    await seed(NOW - 2 * MIN, { orgId: OTHER, action: 'module.enabled', summary: 'THEIRS' });
    await seed(NOW - 1 * MIN, { orgId: null, action: 'user.signed_in', summary: 'INSTALL' });
    const csv = await (await get('/app/audit-log/export.csv', await session('admin'))).text();
    expect(csv).toContain('MINE');
    expect(csv).not.toMatch(/THEIRS|INSTALL/);
    expect((await get('/app/audit-log/export.csv?scope=all', await session('admin'), { accept: 'text/html' })).status).toBe(403);
    const all = await (await get('/app/audit-log/export.csv?scope=all', await session('owner', { instanceOwner: true, email: 'boss@example.com' }))).text();
    for (const text of ['MINE', 'THEIRS', 'INSTALL']) expect(all).toContain(text);
  });

  it('quotes awkward text and neutralises spreadsheet formulas', async () => {
    await seed(NOW - MIN, { action: 'api_key.renamed', actorLabel: '=HYPERLINK("http://example.com")', summary: '=cmd()|"calc"!A0, "quoted"\nsecond line', targetId: '@SUM(1+1)' });
    const csv = await (await get('/app/audit-log/export.csv', await session('admin'))).text();
    expect(csv).toContain(`'=HYPERLINK(""http://example.com"")`);
    expect(csv).toContain(`"'=cmd()|""calc""!A0, ""quoted""\nsecond line"`);
    expect(csv).toContain(`'@SUM(1+1)`);
    expect(csv).not.toMatch(/,=(HYPERLINK|cmd)/);
  });

  it('keeps 300-character and non-Latin text intact', async () => {
    const long = 'あ'.repeat(300);
    await seed(NOW - MIN, { action: 'api_key.renamed', actorLabel: 'Zoë Ünal 李雷', summary: long });
    const csv = await (await get('/app/audit-log/export.csv', await session('admin'))).text();
    expect(csv).toContain('Zoë Ünal 李雷');
    expect(csv).toContain(long);
  });

  it('writes an audit entry for the export, after the file is built', async () => {
    await seed(NOW - MIN, { action: 'user.signed_in' });
    const admin = await session('admin', { email: 'exporter@example.com' });
    const csv = await (await get('/app/audit-log/export.csv', admin)).text();
    expect(csv).not.toContain('audit.exported');
    const html = await (await get('/app/audit-log', admin)).text();
    expect(html).toContain('Exported the audit log');
    expect(html).toContain('Exported 1 audit log entry as CSV');
    expect(html).toContain('exporter@example.com');
  });

  it('refuses a bad filter with a message', async () => {
    const res = await get('/app/audit-log/export.csv?from=2026-02-31', await session('admin'), { accept: 'text/html' });
    expect(res.status).toBe(422);
  });

  it('says when the file was cut at the limit', async () => {
    t.sqlite.exec(
      `INSERT INTO audit_log (id, org_id, actor_type, action, created_at)
       WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${AUDIT_EXPORT_LIMIT + 5})
       SELECT 'aud_bulk' || i, 'org_test', 'user', 'user.signed_in', ${NOW - DAY} - i FROM n`,
    );
    const res = await get('/app/audit-log/export.csv', await session('admin'));
    expect((await res.text()).match(/\r\n\d{4}-/g)).toHaveLength(AUDIT_EXPORT_LIMIT);
    const flash = decodeURIComponent(decodeURIComponent(res.headers.getSetCookie().find((c) => c.startsWith('ts_flash='))!.split(';')[0]!.slice(9)));
    expect(flash).toContain('stopped at 10,000 entries');
  }, 60_000);

  it('adds no notice when everything fit', async () => {
    await seed(NOW - MIN, { action: 'user.signed_in' });
    const res = await get('/app/audit-log/export.csv', await session('admin'));
    expect(res.headers.getSetCookie().some((c) => c.startsWith('ts_flash='))).toBe(false);
  });

  it('is offered on the page with the filter kept, and says what it holds', async () => {
    const html = await (await get('/app/audit-log?q=key&actor=usr_maya', await session('admin'))).text();
    expect(html).toContain('href="/app/audit-log/export.csv?actor=usr_maya&amp;q=key"');
    expect(html).toContain('up to 10,000');
  });
});

describe('how long entries are kept', () => {
  it('lets the install owner see and change it, and records the change', async () => {
    const owner = await session('owner', { instanceOwner: true, email: 'boss@example.com' });
    const page = await (await get('/app/audit-log', owner)).text();
    expect(page).toContain('name="retention"');
    expect(page).toMatch(/<input[^>]*value="90"[^>]*checked/);

    const res = await post('/app/audit-log/retention', owner, { retention: '365' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/audit-log');
    expect(await getAuditRetention(t.env as Env)).toBe(365);

    const trail = t.sqlite.prepare("SELECT actor_id, actor_label, summary, org_id FROM audit_log WHERE action = 'audit.retention_changed'").all() as Record<string, unknown>[];
    expect(trail).toEqual([{ actor_id: owner.user.id, actor_label: 'boss@example.com', summary: 'Chose to keep the audit log for 365 days', org_id: null }]);

    const all = await (await get('/app/audit-log?scope=all', owner)).text();
    expect(all).toContain('Changed how long the audit log is kept');
  });

  it('accepts forever', async () => {
    const owner = await session('owner', { instanceOwner: true, email: 'boss@example.com' });
    expect((await post('/app/audit-log/retention', owner, { retention: 'forever' })).status).toBe(303);
    expect(await getAuditRetention(t.env as Env)).toBe('forever');
  });

  it('shows everyone else the current value as text', async () => {
    const admin = await session('admin');
    const html = await (await get('/app/audit-log', admin)).text();
    expect(html).not.toContain('name="retention"');
    expect(html).toContain('Entries are kept for <b>90 days</b>');
    expect(html).toContain('Only the owner of this install can change that.');
  });

  it('refuses a change from an admin who does not own the install', async () => {
    const admin = await session('admin');
    const res = await post('/app/audit-log/retention', admin, { retention: '30' });
    expect(res.status).toBe(403);
    expect(await getAuditRetention(t.env as Env)).toBe(90);
    expect(t.sqlite.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'audit.retention_changed'").get()).toEqual({ n: 0 });
  });

  it('refuses a made-up value with a message next to the control', async () => {
    const owner = await session('owner', { instanceOwner: true, email: 'boss@example.com' });
    for (const retention of ['7', '', 'never']) {
      const res = await post('/app/audit-log/retention', owner, { retention });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Choose how long to keep entries.');
    }
    expect(await getAuditRetention(t.env as Env)).toBe(90);
  });

  it('blocks a post from another site', async () => {
    const owner = await session('owner', { instanceOwner: true, email: 'boss@example.com' });
    const res = await app().request(
      '/app/audit-log/retention',
      { method: 'POST', headers: { cookie: owner.cookie, origin: 'https://evil.example.com', 'content-type': 'application/x-www-form-urlencoded' }, body: 'retention=30' },
      t.env,
    );
    expect(res.status).toBe(403);
    expect(await getAuditRetention(t.env as Env)).toBe(90);
  });
});

describe('worst-case text', () => {
  const evil = '<script>alert(1)</script>';

  it('escapes script tags in every stored field', async () => {
    await seed(NOW - MIN, {
      action: `x${evil}.y`,
      actorLabel: `a${evil}`,
      targetType: `t${evil}`,
      targetId: `i${evil}`,
      summary: `s${evil}`,
      ip: `p${evil}`,
      meta: { [`k${evil}`]: `v${evil}`, list: [`l${evil}`], nested: { [`n${evil}`]: `m${evil}` } },
    });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // The seed rows above are in the page: check every field made it through escaped.
    const lower = html.toLowerCase();
    for (const prefix of ['x', 'a', 't', 'i', 's', 'p', 'k', 'v', 'l', 'n', 'm']) expect(lower).toContain(`${prefix}&lt;script&gt;`);
  });

  it('cuts 300-character text in the row and keeps all of it in the details', async () => {
    const long = 'W'.repeat(300);
    await seed(NOW - MIN, { action: 'api_key.renamed', actorLabel: long, summary: long, targetId: long, meta: { note: long } });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html).toContain('…');
    expect(html).not.toContain('W'.repeat(200).concat('W'.repeat(101)).slice(0, 301));
    expect(html).toContain(long);
  });

  it('handles non-Latin text and emoji', async () => {
    await seed(NOW - MIN, { action: 'api_key.renamed', actorLabel: '山田 太郎', summary: 'مفتاح جديد 🔑', targetId: 'Ключ-№1' });
    const html = await (await get('/app/audit-log?q=' + encodeURIComponent('山田'), await session('admin'))).text();
    for (const text of ['山田 太郎', 'مفتاح جديد 🔑', 'Ключ-№1']) expect(html).toContain(text);
  });

  it('copes with a huge or odd stored detail', async () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } };
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`key${i}`, i]));
    await seed(NOW - 2 * MIN, { action: 'api_key.renamed', meta: deep });
    await seed(NOW - MIN, { action: 'api_key.rotated', meta: many });
    const html = await (await get('/app/audit-log', await session('admin'))).text();
    expect(html).toContain('30 more not shown');
    expect(html).not.toContain('[object Object]');
  });
});
