/**
 * "Sign in as" lasts an hour. Nothing made during it may outlast it, and everything done during
 * it is marked in the audit log. These run through the whole app with a real session cookie.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { registerModules } from '../../src/core/registry';
import exportRoutes from '../../src/core/routes/export';
import keysRoutes from '../../src/core/routes/keys';
import tokenRoutes from '../../src/core/routes/token';
import webhookRoutes from '../../src/core/routes/webhooks';
import screen from '../../src/dashboard/api-keys';
import { createTestSession } from '../helpers/auth';
import type { TestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import type { TestEnv } from '../helpers/d1';
import { auditRows, tableRows, useModules } from './helpers';

const REFUSAL = 'You can’t do this while signed in as someone else.';
const endpoint = { name: 'Orders', url: 'https://hooks.example.com/in', events: ['*'] };

let t: TestEnv;
let app: ReturnType<typeof createApp>;
let owner: TestSession;
/** Ada herself. */
let ada: TestSession;
/** The install owner signed in as Ada. */
let asAda: TestSession;

beforeEach(async () => {
  t = createTestEnv();
  useModules();
  app = createApp({ screens: { 'api-keys': screen }, routes: { keys: keysRoutes, token: tokenRoutes, webhooks: webhookRoutes, export: exportRoutes } });
  owner = await createTestSession(t.env, { email: 'owner@example.com', role: 'owner', instanceOwner: true, orgId: 'org_owner' });
  ada = await createTestSession(t.env, { email: 'ada@example.com', role: 'admin' });
  asAda = await createTestSession(t.env, { email: 'ada@example.com', role: 'admin' });
  t.sqlite.prepare('UPDATE "session" SET "impersonatedBy" = ? WHERE "id" = ?').run(owner.user.id, asAda.sessionId);
});
afterEach(() => registerModules([]));

async function call(who: TestSession, method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { ...who.headers, accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, t.env);
  const text = await res.text();
  return { status: res.status, json: text.startsWith('{') ? JSON.parse(text) : null };
}

async function refused(method: string, path: string, body?: unknown): Promise<void> {
  const res = await call(asAda, method, path, body);
  expect({ path, status: res.status, message: res.json?.message }).toEqual({ path, status: 403, message: REFUSAL });
}

const metaOf = (action: string): Record<string, unknown> => JSON.parse(auditRows(t, action).at(-1)?.meta ?? '{}') as Record<string, unknown>;

describe('while an install owner is signed in as someone', () => {
  it('makes no API key, service account or token', async () => {
    await refused('POST', '/api/v1/keys', { name: 'Kept for later', scopes: ['*'] });
    await refused('POST', '/api/v1/keys/service-accounts', { name: 'Deploy bot', role: 'admin' });
    await refused('POST', '/api/v1/token');
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
    expect(tableRows(t, 'service_accounts')).toHaveLength(0);

    // The same calls work for Ada herself.
    expect((await call(ada, 'POST', '/api/v1/keys', { name: 'Mine', scopes: ['*'] })).status).toBe(201);
    expect((await call(ada, 'POST', '/api/v1/keys/service-accounts', { name: 'Deploy bot', role: 'admin' })).status).toBe(201);
    expect((await call(ada, 'POST', '/api/v1/token')).status).toBe(200);
  });

  it('cannot replace a key Ada already has', async () => {
    const made = await call(ada, 'POST', '/api/v1/keys', { name: 'Mine', scopes: ['*'] });
    await refused('POST', `/api/v1/keys/${made.json.key.id}/rotate`);
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
  });

  it('adds no webhook endpoint and never sees or replaces a signing secret', async () => {
    await refused('POST', '/api/v1/webhooks', endpoint);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM webhook_endpoints').get()).toEqual({ n: 0 });

    const made = await call(ada, 'POST', '/api/v1/webhooks', endpoint);
    expect(made.status).toBe(201);
    const id = made.json.endpoint.id as string;
    await refused('POST', `/api/v1/webhooks/${id}/rotate`);
    await refused('GET', `/api/v1/webhooks/${id}/secret`);
    expect(auditRows(t, 'webhook.secret_rotated')).toHaveLength(0);
    expect(auditRows(t, 'webhook.secret_viewed')).toHaveLength(0);
  });

  it('starts no workspace export', async () => {
    await refused('POST', '/api/v1/export');
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM exports').get()).toEqual({ n: 0 });
    expect((await call(ada, 'POST', '/api/v1/export')).status).toBe(202);
  });

  it('makes no key from the dashboard, and cannot replace the signing key', async () => {
    const post = async (who: TestSession): Promise<string> => {
      const page = await app.request('/app/api-keys/new', { headers: who.headers }, t.env);
      const token = /name="form_token" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
      expect(token).not.toBe('');
      const form = new URLSearchParams({ form_token: token, name: 'Kept for later', account: '', role: 'admin', expires: 'never' });
      form.append('scopes', '*');
      const res = await app.request(
        '/app/api-keys/new',
        { method: 'POST', headers: { ...who.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString() },
        t.env,
      );
      return res.text();
    };
    expect(await post(asAda)).not.toMatch(/Bearer ts_/);
    expect(tableRows(t, 'api_keys')).toHaveLength(0);
    expect(auditRows(t, 'api_key.created')).toHaveLength(0);

    const rotate = await app.request('/app/api-keys/signing-key/rotate', { method: 'POST', headers: asAda.headers }, t.env);
    expect(rotate.status).toBe(403);

    // The same form makes a key for Ada herself.
    expect(await post(ada)).toMatch(/Bearer ts_/);
    expect(tableRows(t, 'api_keys')).toHaveLength(1);
  });

  it('marks ordinary actions in the audit log with who was really acting', async () => {
    const key = await call(ada, 'POST', '/api/v1/keys', { name: 'Mine', scopes: ['*'] });
    const hook = await call(ada, 'POST', '/api/v1/webhooks', endpoint);
    expect(metaOf('api_key.created')).not.toHaveProperty('impersonatedBy');
    expect(metaOf('webhook.created')).not.toHaveProperty('impersonatedBy');

    // Through `auditKeys`.
    expect((await call(asAda, 'PATCH', `/api/v1/keys/${key.json.key.id}`, { name: 'Renamed' })).status).toBe(200);
    expect(auditRows(t, 'api_key.renamed').at(-1)).toMatchObject({ actor_id: ada.user.id });
    expect(metaOf('api_key.renamed')).toMatchObject({ impersonatedBy: owner.user.id });

    // Through `auditFromRequest`, keeping the entry's own details.
    expect((await call(asAda, 'PATCH', `/api/v1/webhooks/${hook.json.endpoint.id}`, { name: 'Renamed' })).status).toBe(200);
    expect(metaOf('webhook.updated')).toEqual({ fields: ['name'], impersonatedBy: owner.user.id });
    expect((await call(asAda, 'DELETE', `/api/v1/webhooks/${hook.json.endpoint.id}`)).status).toBe(200);
    expect(metaOf('webhook.deleted')).toEqual({ impersonatedBy: owner.user.id });
  });
});
