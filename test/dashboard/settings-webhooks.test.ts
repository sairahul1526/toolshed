import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEndpoint, listEndpoints, updateEndpoint } from '../../src/core/webhooks';
import { registerModules } from '../../src/core/registry';
import { createTestSession } from '../helpers/auth';
import type { TestEnv } from '../helpers/d1';
import { addEndpoint } from '../webhooks/helpers';
import { auditRows, BASE, flashOf, impersonate, makeApp, newEnv, postInit, useLinks } from './settings-helpers';

const HOOKS = `${BASE}/webhooks`;
const URL_OK = 'https://hooks.example.com/in';

let t: TestEnv;
let app: ReturnType<typeof makeApp>;

beforeEach(() => {
  t = newEnv();
  useLinks();
  app = makeApp();
});
afterEach(() => registerModules([]));

const get = (headers: Record<string, string>, path: string) => app.request(path, { headers }, t.env);
const post = (headers: Record<string, string>, path: string, fields: Record<string, string | string[]> = {}) => app.request(path, postInit(headers, fields), t.env);
const tab = async (headers: Record<string, string>) => (await get(headers, `${BASE}?tab=webhooks`)).text();

describe('the list', () => {
  it('shows an empty state with a way to add one', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await tab(headers);
    expect(html).toContain('No webhooks yet');
    expect(html).toContain(`href="${HOOKS}/new"`);
  });

  it('lists endpoints with their state and never the secret', async () => {
    const { headers } = await createTestSession(t.env);
    const { secret } = await addEndpoint(t, { name: 'Orders' });
    const second = await addEndpoint(t, { name: 'Paused one', events: ['links.*'] });
    await updateEndpoint(t.env, 'org_test', second.endpoint.id, { status: 'paused' });
    const html = await tab(headers);
    expect(html).toContain('Orders');
    expect(html).toContain('Sending');
    expect(html).toContain('Everything');
    expect(html).toContain('Paused one');
    expect(html).toContain('Paused');
    expect(html).not.toContain(secret);
  });

  it('only lists the workspace’s own endpoints', async () => {
    const { headers } = await createTestSession(t.env);
    await createTestSession(t.env, { orgId: 'org_other' });
    await addEndpoint(t, { name: 'Elsewhere' }, 'org_other');
    expect(await tab(headers)).not.toContain('Elsewhere');
  });
});

describe('adding one', () => {
  it('offers every event from the installed tools', async () => {
    const { headers } = await createTestSession(t.env);
    const html = await (await get(headers, `${HOOKS}/new`)).text();
    expect(html).toContain('value="*"');
    expect(html).toContain('value="links.*"');
    expect(html).toContain('value="links.link.clicked"');
  });

  it('saves it, shows the signing secret once in this response and writes the audit entry', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, HOOKS, { name: 'Orders', url: URL_OK, events: ['links.link.clicked', 'links.link.created'] });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(flashOf(res)).toBeNull();
    const html = await res.text();
    expect(html).toMatch(/whsec_[A-Za-z0-9+/=_-]+/);
    const [endpoint] = await listEndpoints(t.env, 'org_test');
    expect(endpoint).toMatchObject({ name: 'Orders', url: URL_OK, events: ['links.link.clicked', 'links.link.created'], status: 'active' });
    const rows = await auditRows(t, 'webhook.%');
    expect(rows.map((r) => r.action)).toEqual(['webhook.created']);
    expect(rows[0]!.meta).not.toContain('whsec_');
    // The secret is not on the list or the page of the endpoint afterwards.
    const secret = html.match(/whsec_[A-Za-z0-9+/=_-]+/)![0];
    expect(await tab(headers)).not.toContain(secret);
    expect(await (await get(headers, `${HOOKS}/${endpoint!.id}`)).text()).not.toContain(secret);
  });

  it('keeps what was typed and explains a plain http address', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, HOOKS, { name: 'Orders', url: 'http://hooks.example.com/in', events: ['*'] });
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain('value="Orders"');
    expect(html).toContain('http://hooks.example.com/in');
    expect(html).toContain('starts with https://');
    expect(await listEndpoints(t.env, 'org_test')).toHaveLength(0);
  });

  it('asks for at least one event and keeps the ones ticked', async () => {
    const { headers } = await createTestSession(t.env);
    const res = await post(headers, HOOKS, { name: 'Orders', url: URL_OK });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Pick at least one event');
  });

  it('refuses an empty name and a 300 character name', async () => {
    const { headers } = await createTestSession(t.env);
    expect((await post(headers, HOOKS, { name: '', url: URL_OK, events: '*' })).status).toBe(422);
    const long = 'w'.repeat(300);
    const res = await post(headers, HOOKS, { name: long, url: URL_OK, events: '*' });
    expect(res.status).toBe(422);
    expect(await listEndpoints(t.env, 'org_test')).toHaveLength(0);
  });

  it('escapes markup in a name', async () => {
    const { headers } = await createTestSession(t.env);
    await post(headers, HOOKS, { name: '<script>alert(1)</script>', url: URL_OK, events: '*' });
    const html = await tab(headers);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('says when the workspace has too many', async () => {
    const { headers } = await createTestSession(t.env);
    for (let i = 0; i < 20; i++) await addEndpoint(t, { name: `Hook ${i}` });
    const res = await post(headers, HOOKS, { name: 'One more', url: URL_OK, events: '*' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('limit of 20');
  });
});

describe('one webhook', () => {
  it('shows it, with the events ticked', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t, { name: 'Orders', events: ['links.link.clicked'] });
    const html = await (await get(headers, `${HOOKS}/${endpoint.id}`)).text();
    expect(html).toContain('value="Orders"');
    expect(html).toMatch(/value="links\.link\.clicked"\s+checked/);
    expect(html).toContain('Delete this webhook');
  });

  it('answers 404 for another workspace’s endpoint, for every action', async () => {
    const { headers } = await createTestSession(t.env);
    await createTestSession(t.env, { orgId: 'org_other' });
    const { endpoint } = await addEndpoint(t, { name: 'Elsewhere' }, 'org_other');
    expect((await get(headers, `${HOOKS}/${endpoint.id}`)).status).toBe(404);
    expect((await post(headers, `${HOOKS}/${endpoint.id}`, { name: 'Mine now', url: URL_OK, events: '*' })).status).toBe(404);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/status`, { status: 'paused' })).status).toBe(404);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/secret`)).status).toBe(404);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/delete`)).status).toBe(404);
    expect((await getEndpoint(t.env, 'org_other', endpoint.id)).name).toBe('Elsewhere');
  });

  it('renames it and changes the address and events', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t);
    const res = await post(headers, `${HOOKS}/${endpoint.id}`, { name: 'Renamed', url: 'https://other.example.com/x', events: ['links.*'] });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${HOOKS}/${endpoint.id}`);
    expect(await getEndpoint(t.env, 'org_test', endpoint.id)).toMatchObject({ name: 'Renamed', url: 'https://other.example.com/x', events: ['links.*'] });
    const rows = await auditRows(t, 'webhook.%');
    expect(rows.map((r) => r.action)).toEqual(['webhook.updated']);
  });

  it('keeps the person’s input when a change is refused', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t);
    const res = await post(headers, `${HOOKS}/${endpoint.id}`, { name: 'Renamed', url: 'ftp://nope', events: ['*'] });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('value="Renamed"');
    expect((await getEndpoint(t.env, 'org_test', endpoint.id)).name).toBe('Orders');
  });

  it('pauses and turns it back on', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t);
    const paused = await post(headers, `${HOOKS}/${endpoint.id}/status`, { status: 'paused' });
    expect(paused.status).toBe(303);
    expect((await getEndpoint(t.env, 'org_test', endpoint.id)).status).toBe('paused');
    expect(await (await get(headers, `${HOOKS}/${endpoint.id}`)).text()).toContain('Turn on');
    await post(headers, `${HOOKS}/${endpoint.id}/status`, { status: 'active' });
    expect((await getEndpoint(t.env, 'org_test', endpoint.id)).status).toBe('active');
  });

  it('shows a turned off endpoint with the reason', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t);
    await t.env.DB.prepare(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'It answered with errors for 3 days.' WHERE id = ?1`).bind(endpoint.id).run();
    const html = await (await get(headers, `${HOOKS}/${endpoint.id}`)).text();
    expect(html).toContain('Toolshed turned this off');
    expect(html).toContain('answered with errors for 3 days');
  });

  it('shows the secret again on a post, with no-store and an audit entry', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint, secret } = await addEndpoint(t);
    const res = await post(headers, `${HOOKS}/${endpoint.id}/secret`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toContain(secret);
    expect((await auditRows(t, 'webhook.secret_viewed'))).toHaveLength(1);
    // A plain GET of that address is not a way to the secret.
    const viaGet = await get(headers, `${HOOKS}/${endpoint.id}/secret`);
    expect(viaGet.status).not.toBe(200);
  });

  it('deletes it', async () => {
    const { headers } = await createTestSession(t.env);
    const { endpoint } = await addEndpoint(t);
    const res = await post(headers, `${HOOKS}/${endpoint.id}/delete`);
    expect(res.status).toBe(303);
    expect(flashOf(res)?.message).toContain('Deleted');
    expect(await listEndpoints(t.env, 'org_test')).toHaveLength(0);
    expect((await auditRows(t, 'webhook.deleted'))).toHaveLength(1);
  });

  it.each(['member', 'viewer'] as const)('refuses a %s for every action', async (role) => {
    const { headers } = await createTestSession(t.env, { role });
    const { endpoint } = await addEndpoint(t);
    expect((await get(headers, `${HOOKS}/${endpoint.id}`)).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}`, { name: 'x', url: URL_OK, events: '*' })).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/status`, { status: 'paused' })).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/secret`)).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/delete`)).status).toBe(403);
  });
});

describe('while signed in as someone else', () => {
  it('allows a rename and nothing else', async () => {
    const { headers, sessionId } = await createTestSession(t.env, { role: 'admin' });
    const { endpoint } = await addEndpoint(t);
    await impersonate(t, sessionId);

    const page = await (await get(headers, `${HOOKS}/${endpoint.id}`)).text();
    expect(page).toContain('Signed in as someone else');

    // The form sends only the name here, but a hand-made post with more must not change the rest.
    const rename = await post(headers, `${HOOKS}/${endpoint.id}`, { name: 'Renamed', url: 'https://evil.example.com/x', events: ['links.*'] });
    expect(rename.status).toBe(303);
    expect(await getEndpoint(t.env, 'org_test', endpoint.id)).toMatchObject({ name: 'Renamed', url: URL_OK, events: ['*'] });

    expect((await post(headers, HOOKS, { name: 'New', url: URL_OK, events: '*' })).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/status`, { status: 'paused' })).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/secret`)).status).toBe(403);
    expect((await post(headers, `${HOOKS}/${endpoint.id}/delete`)).status).toBe(403);
    expect(await listEndpoints(t.env, 'org_test')).toHaveLength(1);
    expect((await getEndpoint(t.env, 'org_test', endpoint.id)).status).toBe('active');
  });
});
