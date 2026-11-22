import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { createApiKey, createServiceAccount, revokeApiKey, touchApiKey } from '../../src/core/apikeys';
import type { CreateKeyInput, KeyActor } from '../../src/core/apikeys';
import { registerModules } from '../../src/core/registry';
import screen from '../../src/dashboard/api-keys';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { actor, DAY, ORG_B, T0, tableRows, useModules } from '../keys/helpers';

const ORG = 'org_test';
const admin = actor('admin', 'usr_admin', ORG);

let t: TestEnv;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  t = createTestEnv();
  useModules();
  app = createApp({ screens: { 'api-keys': screen } });
});
afterEach(() => registerModules([]));

const make = (input: Partial<CreateKeyInput> = {}, who: KeyActor = admin, now = T0) =>
  createApiKey(t.env, who, { name: 'Deploy script', scopes: ['links:read'], expiresInDays: null, ...input }, now);

async function page(path: string, role: 'owner' | 'admin' | 'member' | 'viewer' = 'admin'): Promise<{ res: Response; html: string }> {
  const { headers } = await createTestSession(t.env, { role, orgId: ORG });
  const res = await app.request(path, { headers }, t.env);
  return { res, html: await res.text() };
}

/** How many rows of the keys table a page shows. */
const rowCount = (html: string) => (html.match(/<a class="trunc" href="\/app\/api-keys\/[^"?/]+" title=/g) ?? []).length;

describe('who can open the screen', () => {
  it('sends a signed-out browser to sign-in', async () => {
    const res = await app.request('/app/api-keys', {}, t.env);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?next=%2Fapp%2Fapi-keys');
  });

  it.each(['owner', 'admin'] as const)('shows the list to a workspace %s', async (role) => {
    const { res, html } = await page('/app/api-keys', role);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Make a key');
  });

  it.each(['member', 'viewer'] as const)('shows a %s a forbidden page and nothing else', async (role) => {
    await make({ name: 'Private deploy key' });
    for (const path of ['/app/api-keys', '/app/api-keys/new', '/app/api-keys/accounts/new']) {
      const { res, html } = await page(path, role);
      expect(res.status).toBe(403);
      expect(html).toContain('Only workspace admins can do that');
      expect(html).not.toContain('Private deploy key');
    }
  });

  it('refuses an API key or a token, even one that acts as an admin with every scope', async () => {
    await createTestSession(t.env, { orgId: ORG });
    const { secret } = await make({ name: 'Powerful key', scopes: ['*'], role: 'admin' });
    const bearer = { authorization: `Bearer ${secret}` };
    const read = await app.request('/app/api-keys', { headers: bearer }, t.env);
    expect(read.status).toBe(403);
    expect(await read.text()).toContain('Sign in to the dashboard');
    const write = await app.request('/app/api-keys/new', { method: 'POST', headers: { ...bearer, 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=Sneaky&scopes=*&role=admin&expires=never' }, t.env);
    expect(write.status).toBe(403);
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
  });
});

describe('the list of keys', () => {
  it('has an empty state with one next step', async () => {
    const { html } = await page('/app/api-keys');
    expect(html).toContain('No keys yet');
    expect(html).toContain('href="/app/api-keys/new"');
    expect(rowCount(html)).toBe(0);
  });

  it('shows name, visible prefix, kind, role, permissions, who made it and when', async () => {
    const sa = await createServiceAccount(t.env, admin, { name: 'Billing sync', role: 'viewer' }, T0);
    const personal = await make({ name: 'Zapier', scopes: ['links:read', 'links:write'], role: 'member' });
    await make({ name: 'Backup', scopes: ['*'], serviceAccountId: sa.id });
    const { html } = await page('/app/api-keys');
    expect(html).toContain('Zapier');
    expect(html).toContain(`${personal.key.prefix}…`);
    expect(html).toContain('Personal');
    expect(html).toContain('Acts as Member');
    expect(html).toContain('links:read');
    expect(html).toContain('links:write');
    expect(html).toContain('Service account: Billing sync');
    expect(html).toContain('Acts as Viewer');
    expect(html).toContain('Full access');
    expect(html).toContain('usr_admin@example.com');
    expect(html).toContain('Never used');
    // The secret and its hash are never part of a list.
    expect(html).not.toContain(personal.secret);
    expect(html).not.toMatch(/key_hash/);
  });

  it('shows when a key was last used and from where', async () => {
    const { key } = await make({ name: 'Cron' });
    await touchApiKey(t.env, { keyId: key.id, orgId: ORG, lastUsedAt: null }, { ip: '203.0.113.9', now: Date.now() - 3 * 60 * 60 * 1000 });
    const { html } = await page('/app/api-keys');
    expect(html).toContain('3 hours ago from 203.0.113.9');
    expect(html).not.toContain('Never used');
  });

  it('shows active, expiring soon, expired and revoked keys as such', async () => {
    const now = Date.now();
    await make({ name: 'Fresh key', expiresInDays: 365 }, admin, now);
    await make({ name: 'Ending key', expiresInDays: 90 }, admin, now - 80 * DAY);
    await make({ name: 'Old key', expiresInDays: 30 }, admin, T0);
    const gone = await make({ name: 'Revoked key' });
    await revokeApiKey(t.env, admin, gone.key.id);

    const shown = (await page('/app/api-keys')).html;
    expect(shown).toContain('Active');
    expect(shown).toContain('Expiring soon');
    expect(shown).toContain('Stops in 10 days');
    expect(shown).toContain('Expired');
    expect(shown).not.toContain('Revoked key');

    const all = (await page('/app/api-keys?revoked=1')).html;
    expect(all).toContain('Revoked key');
    expect(all).toContain('Hide revoked keys');
    expect(shown).toContain('Show revoked keys');
  });

  it('pages with a cursor, keeping the filter in the link', async () => {
    for (let i = 0; i < 55; i++) await make({ name: `Key ${String(i).padStart(2, '0')}` }, admin, T0 + i * 1000);
    const first = (await page('/app/api-keys')).html;
    expect(rowCount(first)).toBe(50);
    expect(first).toContain('Key 54');
    expect(first).not.toContain('Key 04');
    const next = /href="(\/app\/api-keys\?after=[^"]+)"/.exec(first)?.[1];
    expect(next).toBeTruthy();

    const second = (await page(next!)).html;
    expect(rowCount(second)).toBe(5);
    expect(second).toContain('Key 04');
    expect(second).not.toContain('Key 54');
    expect(second).toContain('Back to first page');
    expect(second).not.toContain('>Next<');

    const withRevoked = (await page('/app/api-keys?revoked=1')).html;
    expect(withRevoked).toMatch(/href="\/app\/api-keys\?revoked=1&amp;after=[^"]+"/);
  });

  it('starts again from the top when the cursor is no longer in the list', async () => {
    await make({ name: 'Only key' });
    const { res, html } = await page('/app/api-keys?after=key_gone');
    expect(res.status).toBe(200);
    expect(html).toContain('Only key');
  });

  it('never shows another workspace’s keys', async () => {
    await make({ name: 'Mine' });
    await createApiKey(t.env, actor('admin', 'usr_other', ORG_B), { name: 'Theirs', scopes: ['links:read'] }, T0);
    const { html } = await page('/app/api-keys?revoked=1');
    expect(html).toContain('Mine');
    expect(html).not.toContain('Theirs');
  });
});

describe('service accounts tab', () => {
  it('has an empty state with one next step', async () => {
    const { html } = await page('/app/api-keys?tab=accounts');
    expect(html).toContain('No service accounts yet');
    expect(html).toContain('href="/app/api-keys/accounts/new"');
  });

  it('lists each account with its role and how many keys work', async () => {
    const sa = await createServiceAccount(t.env, admin, { name: 'Billing sync', role: 'viewer' }, Date.now());
    await make({ name: 'Sync key', serviceAccountId: sa.id });
    const { html } = await page('/app/api-keys?tab=accounts');
    expect(html).toContain('Billing sync');
    expect(html).toContain('Viewer');
    expect(html).toContain(`href="/app/api-keys/accounts/${sa.id}"`);
  });
});

describe('using the API', () => {
  it('names the base URL, the header, the docs and the token exchange', async () => {
    const { html } = await page('/app/api-keys');
    expect(html).toContain('http://localhost/api/v1');
    expect(html).toContain('Authorization: Bearer');
    expect(html).toContain('docs/api.md');
    expect(html).toContain('POST /api/v1/token');
    expect(html).toContain('15 minutes');
  });
});

describe('worst-case data', () => {
  const script = '<script>alert(1)</script>';

  it('escapes markup and keeps long or non-Latin names in the table', async () => {
    const long = 'Q'.repeat(80);
    await make({ name: script });
    await make({ name: long });
    await make({ name: '日本語のキー 🔑 مفتاح' });
    await createServiceAccount(t.env, { ...admin, label: script }, { name: script, role: 'viewer' }, Date.now());
    await make({ name: 'Labelled' }, { ...admin, label: script });

    for (const path of ['/app/api-keys', '/app/api-keys?tab=accounts']) {
      const { res, html } = await page(path);
      expect(res.status).toBe(200);
      expect(html).not.toContain('<script>alert');
      expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    }
    const list = (await page('/app/api-keys')).html;
    expect(list).toContain(long);
    expect(list).toContain('日本語のキー 🔑 مفتاح');
  });

  it('escapes markup on the key page', async () => {
    const { key } = await make({ name: script });
    const { html } = await page(`/app/api-keys/${key.id}`);
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
