import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import routes from '../../src/core/routes/webhooks';
import { createTestEnv } from '../helpers/d1';
import { ORG_A, ORG_B, anon, auditRows, mount, session, viaJwt, viaKey } from '../keys/helpers';
import type { Caller } from '../keys/helpers';
import { RECEIVER, stubFetch } from './helpers';

afterEach(() => {
  registerModules([]);
  vi.unstubAllGlobals();
});

const BASE = '/api/v1/webhooks';
const input = { name: 'Orders', url: RECEIVER, events: ['*'] };

function api(who: Caller, t = createTestEnv()) {
  const call = mount(t.env, routes, BASE, who);
  return { t, call: (method: string, path = '', body?: unknown) => call(method, `${BASE}${path}`, body) };
}

/** One endpoint made through the API by a signed-in admin, then used by the caller under test. */
async function withEndpoint(who: Caller) {
  const t = createTestEnv();
  const admin = mount(t.env, routes, BASE, session('admin'));
  const made = await admin('POST', BASE, input);
  const call = mount(t.env, routes, BASE, who);
  return { t, id: made.json.endpoint.id as string, secret: made.json.secret as string, call: (m: string, p = '', b?: unknown) => call(m, `${BASE}${p}`, b) };
}

describe('who may use it', () => {
  it.each(['member', 'viewer'] as const)('refuses a %s', async (role) => {
    const { call } = api(session(role));
    expect((await call('GET')).status).toBe(403);
    expect((await call('POST', '', input)).status).toBe(403);
  });

  it('refuses someone who is not signed in', async () => {
    const { call } = api(anon);
    expect([401, 403]).toContain((await call('GET')).status);
  });

  it('lets a signed-in admin do everything', async () => {
    const { call } = api(session('admin'));
    expect((await call('GET')).status).toBe(200);
    expect((await call('POST', '', input)).status).toBe(201);
  });

  it('lets a key with webhooks:read look but not change', async () => {
    const { call, id } = await withEndpoint(viaKey('admin', ['webhooks:read']));
    expect((await call('GET')).status).toBe(200);
    expect((await call('GET', `/${id}`)).status).toBe(200);
    expect((await call('GET', '/deliveries')).status).toBe(200);
    expect((await call('GET', '/events')).status).toBe(200);
    for (const [method, path, body] of [
      ['POST', '', input],
      ['PATCH', `/${id}`, { name: 'x' }],
      ['DELETE', `/${id}`, undefined],
      ['POST', `/${id}/test`, undefined],
      ['POST', '/deliveries/whd_x/resend', undefined],
    ] as const) {
      const res = await call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.message).toContain('webhooks:write');
    }
  });

  it.each([['webhooks:write'], ['*'], ['webhooks:*']])('lets a key with %s read and change', async (scope) => {
    const { call, id } = await withEndpoint(viaKey('admin', [scope]));
    expect((await call('GET', `/${id}`)).status).toBe(200);
    expect((await call('PATCH', `/${id}`, { name: 'Renamed' })).status).toBe(200);
    expect((await call('POST', '', { ...input, name: 'Second' })).status).toBe(201);
  });

  it('refuses a key for another module, and a key held by a member', async () => {
    expect((await api(viaKey('admin', ['links:read'])).call('GET')).status).toBe(403);
    expect((await api(viaKey('admin', ['links:*'])).call('POST', '', input)).status).toBe(403);
    expect((await api(viaKey('member', ['webhooks:*', '*'])).call('GET')).status).toBe(403);
  });

  it('treats a token like a key', async () => {
    const { call } = api(viaJwt('admin', ['webhooks:read']));
    expect((await call('GET')).status).toBe(200);
    expect((await call('POST', '', input)).status).toBe(403);
  });
});

describe('secrets are for signed-in people', () => {
  it('lets a key create an endpoint and get the secret back once', async () => {
    const { call } = api(viaKey('admin', ['webhooks:write']));
    const res = await call('POST', '', input);
    expect(res.status).toBe(201);
    expect(res.json.secret).toMatch(/^whsec_/);
    expect(res.json.endpoint.createdBy).toBe('key_caller');
  });

  it.each(['webhooks:write', '*', 'webhooks:*'])('refuses to show or rotate the secret to a key with %s', async (scope) => {
    const { call, id } = await withEndpoint(viaKey('admin', [scope]));
    const shown = await call('GET', `/${id}/secret`);
    expect(shown.status).toBe(403);
    expect(shown.json.code).toBe('webhooks.session_required');
    const rotated = await call('POST', `/${id}/rotate`);
    expect(rotated.status).toBe(403);
    expect(rotated.json.code).toBe('webhooks.session_required');
  });

  it('refuses a token too', async () => {
    const { call, id } = await withEndpoint(viaJwt('admin', ['*']));
    expect((await call('GET', `/${id}/secret`)).status).toBe(403);
  });

  it('shows the secret and rotates it for a signed-in admin', async () => {
    const { call, id, secret } = await withEndpoint(session('admin'));
    const shown = await call('GET', `/${id}/secret`);
    expect(shown.json).toEqual({ secret });
    const rotated = await call('POST', `/${id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.json.secret).toMatch(/^whsec_/);
    expect(rotated.json.secret).not.toBe(secret);
    expect(typeof rotated.json.previousSecretExpiresAt).toBe('number');
    expect((await call('GET', `/${id}/secret`)).json.secret).toBe(rotated.json.secret);
  });
});

describe('what comes back', () => {
  it('never puts the secret or a header value in a list or a single endpoint', async () => {
    const t = createTestEnv();
    const call = mount(t.env, routes, BASE, session('admin'));
    const made = await call('POST', BASE, { ...input, headers: { 'X-Token': 'very-private-value' } });
    const text = JSON.stringify([(await call('GET', BASE)).json, (await call('GET', `${BASE}/${made.json.endpoint.id}`)).json, made.json.endpoint]);
    expect(text).not.toContain(made.json.secret);
    expect(text).not.toContain('very-private-value');
    expect(text).toContain('X-Token');
  });

  it('is not cached', async () => {
    const { call } = api(session('admin'));
    const res = await call('POST', '', input);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await call('GET')).headers.get('cache-control')).toBe('no-store');
  });

  it('lists the events modules say they emit, and is not mistaken for an endpoint id', async () => {
    registerModules([defineModule({ id: 'links', name: 'Links', description: 'x', icon: 'link', category: 'growth', version: '1.0.0', permissions: [], events: { emits: ['link.clicked'] } })]);
    const { call } = api(session('admin'));
    const res = await call('GET', '/events');
    expect(res.status).toBe(200);
    expect(res.json.events).toEqual([{ type: 'links.link.clicked', module: 'links', moduleName: 'Links' }]);
    expect((await call('GET', '/deliveries')).json).toEqual({ deliveries: [], nextCursor: null });
  });

  it('answers with a plain error and per-field messages for bad input', async () => {
    const { call } = api(session('admin'));
    const res = await call('POST', '', { name: '', url: 'http://10.0.0.1/x', events: ['nope'] });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe('validation_failed');
    expect(Object.keys(res.json.fields)).toEqual(expect.arrayContaining(['name', 'url', 'events.0']));
  });

  it('reports a missing endpoint and the other workspace’s endpoint the same way', async () => {
    const t = createTestEnv();
    const a = mount(t.env, routes, BASE, session('admin', 'usr_a', ORG_A));
    const b = mount(t.env, routes, BASE, session('admin', 'usr_b', ORG_B));
    const made = await a('POST', BASE, input);
    const id = made.json.endpoint.id;
    for (const [method, path] of [['GET', ''], ['PATCH', ''], ['DELETE', ''], ['GET', '/secret'], ['POST', '/rotate'], ['POST', '/test']] as const) {
      expect((await b(method, `${BASE}/${id}${path}`, method === 'PATCH' ? { name: 'x' } : undefined)).status, `${method} ${path}`).toBe(404);
    }
    expect((await b('GET', BASE)).json.endpoints).toEqual([]);
    expect((await b('GET', `${BASE}/whd_nothing`)).status).toBe(404);
  });
});

describe('changing things', () => {
  it('edits, pauses and deletes', async () => {
    const { call, id } = await withEndpoint(session('admin'));
    const edited = await call('PATCH', `/${id}`, { name: 'New name', status: 'paused' });
    expect(edited.json.endpoint).toMatchObject({ name: 'New name', status: 'paused' });
    expect((await call('PATCH', `/${id}`, { status: 'disabled' })).status).toBe(422);
    expect((await call('PATCH', `/${id}`, { nope: 1 })).status).toBe(422);
    expect((await call('DELETE', `/${id}`)).json).toEqual({ ok: true });
    expect((await call('GET', `/${id}`)).status).toBe(404);
  });

  it('sends a test event and returns the answer', async () => {
    const sent = stubFetch();
    const { call, id } = await withEndpoint(session('admin'));
    const res = await call('POST', `/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ ok: true, statusCode: 200 });
    expect(res.json.delivery).toMatchObject({ eventType: 'webhook.test', status: 'success' });
    expect(sent).toHaveLength(1);
  });

  it('shows a failed test as a normal answer, not an error', async () => {
    stubFetch(() => new Response('bad', { status: 500 }));
    const { call, id } = await withEndpoint(session('admin'));
    const res = await call('POST', `/${id}/test`);
    expect(res.status).toBe(200);
    expect(res.json.result).toMatchObject({ ok: false, errorCode: 'http_500' });
  });

  it('refuses a test for a disabled endpoint', async () => {
    const { t, call, id } = await withEndpoint(session('admin'));
    t.sqlite.prepare("UPDATE webhook_endpoints SET status = 'disabled'").run();
    const res = await call('POST', `/${id}/test`);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('webhooks.endpoint_disabled');
  });

  it('reads the log and sends a delivery again', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const { t, call, id } = await withEndpoint(session('admin'));
    await call('POST', `/${id}/test`);
    const list = await call('GET', `/deliveries?endpoint=${id}&event=webhook.test`);
    expect(list.json.deliveries).toHaveLength(1);
    const deliveryId = list.json.deliveries[0].id;
    const one = await call('GET', `/deliveries/${deliveryId}`);
    expect(one.json.delivery.attempts).toHaveLength(1);
    expect((await call('GET', '/deliveries?limit=0')).status).toBe(422);

    const again = await call('POST', `/deliveries/${deliveryId}/resend`);
    expect(again.status).toBe(202);
    expect(again.json.delivery).toMatchObject({ id: deliveryId, status: 'pending' });
    expect(t.queue.sent.filter((m) => m.body.name === 'core.webhook.deliver')).toHaveLength(1);
    expect((await call('POST', `/deliveries/${deliveryId}/resend`)).json.code).toBe('webhooks.delivery_pending');
  });
});

describe('the audit log', () => {
  it('records every change without the address or the secret', async () => {
    stubFetch();
    const { t, call, id, secret } = await withEndpoint(session('admin'));
    await call('PATCH', `/${id}`, { name: 'Renamed' });
    await call('PATCH', `/${id}`, {});
    await call('GET', `/${id}/secret`);
    await call('POST', `/${id}/rotate`);
    await call('POST', `/${id}/test`);
    await call('DELETE', `/${id}`);

    const actions = auditRows(t).map((r) => r.action);
    expect(actions).toEqual(['webhook.created', 'webhook.updated', 'webhook.secret_viewed', 'webhook.secret_rotated', 'webhook.tested', 'webhook.deleted']);
    const everything = JSON.stringify(auditRows(t));
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain('hooks.example.com');
    expect(everything).not.toContain('whsec_');
    expect(auditRows(t, 'webhook.created')[0]).toMatchObject({ org_id: ORG_A, actor_type: 'user', target_type: 'webhook_endpoint', target_id: id });
  });

  it('writes nothing for a refused or empty change', async () => {
    const { t, call, id } = await withEndpoint(viaKey('admin', ['webhooks:read']));
    await call('PATCH', `/${id}`, { name: 'x' });
    await call('GET', `/${id}/secret`);
    expect(auditRows(t)).toHaveLength(1);
  });
});

describe('limits on use', () => {
  it('allows 20 new endpoints an hour and then says to wait', async () => {
    const { call } = api(session('admin'));
    for (let i = 0; i < 20; i++) expect((await call('POST', '', { ...input, name: `E${i}` })).status).toBe(201);
    const res = await call('POST', '', { ...input, name: 'E21' });
    expect(res.status).toBe(429);
    expect(res.json.code).toBe('rate_limited');
  });

  it('allows 20 test events in ten minutes', async () => {
    stubFetch();
    const { call, id } = await withEndpoint(session('admin'));
    for (let i = 0; i < 20; i++) expect((await call('POST', `/${id}/test`)).status).toBe(200);
    expect((await call('POST', `/${id}/test`)).status).toBe(429);
  });

  it('allows 60 resends in ten minutes', async () => {
    const { call } = await withEndpoint(session('admin'));
    for (let i = 0; i < 60; i++) expect((await call('POST', '/deliveries/whd_none/resend')).status).toBe(404);
    expect((await call('POST', '/deliveries/whd_none/resend')).status).toBe(429);
  });

  it('allows 10 secret changes an hour', async () => {
    const { call, id } = await withEndpoint(session('admin'));
    for (let i = 0; i < 10; i++) expect((await call('POST', `/${id}/rotate`)).status).toBe(200);
    expect((await call('POST', `/${id}/rotate`)).status).toBe(429);
  });

  it('counts each workspace on its own', async () => {
    const t = createTestEnv();
    const a = mount(t.env, routes, BASE, session('admin', 'usr_a', ORG_A));
    const b = mount(t.env, routes, BASE, session('admin', 'usr_b', ORG_B));
    for (let i = 0; i < 20; i++) await a('POST', BASE, { ...input, name: `E${i}` });
    expect((await a('POST', BASE, input)).status).toBe(429);
    expect((await b('POST', BASE, input)).status).toBe(201);
  });
});
