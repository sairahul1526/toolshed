import { describe, expect, it } from 'vitest';
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  matchesEvent,
  revealEndpointSecret,
  rotateEndpointSecret,
  updateEndpoint,
} from '../../src/core/webhooks';
import { purgeOrgData } from '../../src/core/registry';
import { createTestEnv } from '../helpers/d1';
import { failure } from '../keys/helpers';
import { ADMIN, RECEIVER, addEndpoint, makeDeliveries, row, rows, stubFetch } from './helpers';

const create = (t: ReturnType<typeof createTestEnv>, input: Record<string, unknown>) =>
  createEndpoint(t.env, t.org.id, ADMIN, { name: 'Orders', url: RECEIVER, events: ['*'], ...input });

describe('creating an endpoint', () => {
  it('returns the endpoint and its secret, and shows header names but never values', async () => {
    const t = createTestEnv();
    const { endpoint, secret } = await create(t, { description: 'Order feed', headers: { 'X-Api-Token': 'super-private-value' }, events: ['links.*', 'forms.form.submitted'] });
    expect(endpoint.id).toMatch(/^whe_/);
    expect(secret).toMatch(/^whsec_/);
    expect(endpoint).toMatchObject({
      name: 'Orders',
      description: 'Order feed',
      url: RECEIVER,
      events: ['links.*', 'forms.form.submitted'],
      headerNames: ['X-Api-Token'],
      status: 'active',
      disabledReason: null,
      createdBy: 'usr_admin',
      lastSuccessAt: null,
      lastFailureAt: null,
      consecutiveFailures: 0,
    });
    const shown = JSON.stringify([endpoint, await getEndpoint(t.env, t.org.id, endpoint.id), await listEndpoints(t.env, t.org.id)]);
    expect(shown).not.toContain(secret);
    expect(shown).not.toContain('super-private-value');
  });

  it('stores the secret and header values sealed, never in clear text', async () => {
    const t = createTestEnv();
    const { endpoint, secret } = await create(t, { headers: { Authorization: 'Bearer abc-123-private' } });
    const stored = row(t, 'SELECT * FROM webhook_endpoints WHERE id = ?', endpoint.id);
    const everything = JSON.stringify(stored);
    expect(everything).not.toContain(secret);
    expect(everything).not.toContain(secret.slice('whsec_'.length));
    expect(everything).not.toContain('abc-123-private');
    expect(stored.secret_enc).toMatch(/^v1\./);
    expect(stored.headers_enc).toMatch(/^v1\./);
    expect((await revealEndpointSecret(t.env, t.org.id, endpoint.id)).secret).toBe(secret);
  });

  it('will not open a secret copied onto another endpoint', async () => {
    const t = createTestEnv();
    const a = await create(t, { name: 'A' });
    const b = await create(t, { name: 'B' });
    const sealed = row(t, 'SELECT secret_enc FROM webhook_endpoints WHERE id = ?', a.endpoint.id).secret_enc;
    t.sqlite.prepare('UPDATE webhook_endpoints SET secret_enc = ? WHERE id = ?').run(sealed, b.endpoint.id);
    expect((await failure(() => revealEndpointSecret(t.env, t.org.id, b.endpoint.id))).code).toBe('conflict');
  });

  it('turns every secret into something different', async () => {
    const t = createTestEnv();
    const a = await create(t, {});
    const b = await create(t, {});
    expect(a.secret).not.toBe(b.secret);
  });

  it('allows 20 endpoints per workspace and says so on the 21st', async () => {
    const t = createTestEnv();
    for (let i = 0; i < 20; i++) await create(t, { name: `Endpoint ${i}` });
    const err = await failure(() => create(t, { name: 'One too many' }));
    expect(err.code).toBe('webhooks.too_many');
    expect(err.status).toBe(409);
    expect(err.message).toContain('20');
    // Another workspace has its own 20.
    await createEndpoint(t.env, 'org_other', ADMIN, { name: 'Elsewhere', url: RECEIVER, events: ['*'] });
    expect(await listEndpoints(t.env, t.org.id)).toHaveLength(20);
  });
});

describe('addresses', () => {
  it.each([
    ['plain http', 'http://hooks.example.com/in'],
    ['localhost', 'https://localhost/in'],
    ['a loopback address', 'https://127.0.0.1/in'],
    ['a private 10.x address', 'https://10.0.0.5/in'],
    ['a private 192.168.x address', 'https://192.168.1.20/in'],
    ['the cloud metadata address', 'https://169.254.169.254/latest'],
    ['an IPv6 loopback', 'https://[::1]/in'],
    ['a decimal IP', 'https://2130706433/in'],
    ['an internal name', 'https://service.internal/in'],
    ['a name with no dot', 'https://intranet/in'],
    ['credentials in the address', 'https://user:pass@hooks.example.com/in'],
    ['another scheme', 'ftp://hooks.example.com/in'],
    ['not an address', 'hooks please'],
  ])('refuses %s', async (_label, url) => {
    const t = createTestEnv();
    const err = await failure(() => create(t, { url }));
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toHaveProperty('url');
  });

  it('refuses a new private address on update too', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, {});
    const err = await failure(() => updateEndpoint(t.env, t.org.id, endpoint.id, { url: 'https://10.1.1.1/x' }));
    expect(err.fields).toHaveProperty('url');
  });
});

describe('custom headers', () => {
  it.each(['Host', 'content-type', 'Content-Length', 'User-Agent', 'webhook-id', 'Webhook-Signature', 'cf-connecting-ip', 'X-Forwarded-For', 'Transfer-Encoding', 'Cookie'])(
    'blocks %s',
    async (name) => {
      const t = createTestEnv();
      const err = await failure(() => create(t, { headers: { [name]: 'x' } }));
      expect(err.fields).toHaveProperty(`headers.${name}`);
    },
  );

  it('allows 10 and refuses 11', async () => {
    const t = createTestEnv();
    const headers = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`X-Key-${i}`, 'v']));
    const { endpoint } = await create(t, { headers: headers(10) });
    expect(endpoint.headerNames).toHaveLength(10);
    expect((await failure(() => create(t, { headers: headers(11) }))).fields).toHaveProperty('headers');
  });

  it('refuses a bad name, an empty value, a multi-line value and the same name twice', async () => {
    const t = createTestEnv();
    expect((await failure(() => create(t, { headers: { 'bad name': 'x' } }))).fields).toHaveProperty('headers.bad name');
    expect((await failure(() => create(t, { headers: { 'X-One': '' } }))).fields).toHaveProperty('headers.X-One');
    expect((await failure(() => create(t, { headers: { 'X-One': 'a\r\nInjected: yes' } }))).fields).toHaveProperty('headers.X-One');
    expect((await failure(() => create(t, { headers: { 'X-One': 'a', 'x-one': 'b' } }))).fields).toHaveProperty('headers.x-one');
  });
});

describe('event patterns', () => {
  it('accepts an exact name, a module and everything, and drops repeats', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, { events: ['links.link.clicked', 'links.*', '*', 'links.*'] });
    expect(endpoint.events).toEqual(['links.link.clicked', 'links.*', '*']);
  });

  it.each(['', 'links', 'Links.*', 'links.', '*.clicked', 'links.*.clicked', 'a b', '**'])('refuses %j', async (pattern) => {
    const t = createTestEnv();
    expect((await failure(() => create(t, { events: [pattern] }))).fields).toHaveProperty('events.0');
  });

  it('needs at least one event', async () => {
    const t = createTestEnv();
    expect((await failure(() => create(t, { events: [] }))).fields).toHaveProperty('events');
  });

  it('matches exactly, by module, or by everything', () => {
    expect(matchesEvent(['*'], 'links.link.clicked')).toBe(true);
    expect(matchesEvent(['links.*'], 'links.link.clicked')).toBe(true);
    expect(matchesEvent(['links.link.clicked'], 'links.link.clicked')).toBe(true);
    expect(matchesEvent(['links.link.clicked'], 'links.link.created')).toBe(false);
    expect(matchesEvent(['links.*'], 'linksextra.thing.happened')).toBe(false);
    expect(matchesEvent(['forms.*', 'links.link.created'], 'links.link.clicked')).toBe(false);
    expect(matchesEvent([], 'links.link.clicked')).toBe(false);
  });
});

describe('other fields', () => {
  it('needs a name and refuses long ones', async () => {
    const t = createTestEnv();
    expect((await failure(() => create(t, { name: '  ' }))).fields).toHaveProperty('name');
    expect((await failure(() => create(t, { name: 'x'.repeat(81) }))).fields).toHaveProperty('name');
    expect((await failure(() => create(t, { description: 'x'.repeat(301) }))).fields).toHaveProperty('description');
  });

  it('refuses fields it does not know', async () => {
    const t = createTestEnv();
    expect((await failure(() => create(t, { secret: 'whsec_mine' }))).code).toBe('validation_failed');
  });
});

describe('changing an endpoint', () => {
  it('changes only what was sent and says which fields changed', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, { description: 'Old', headers: { 'X-A': '1' } });
    const { endpoint: after, changed } = await updateEndpoint(t.env, t.org.id, endpoint.id, { name: 'New name', events: ['forms.*'], description: null });
    expect(changed.sort()).toEqual(['description', 'events', 'name']);
    expect(after).toMatchObject({ name: 'New name', events: ['forms.*'], description: null, url: RECEIVER, headerNames: ['X-A'] });
  });

  it('replaces the headers when sent, and clears them with an empty object', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, { headers: { 'X-A': '1' } });
    expect((await updateEndpoint(t.env, t.org.id, endpoint.id, { headers: { 'X-B': '2' } })).endpoint.headerNames).toEqual(['X-B']);
    const cleared = await updateEndpoint(t.env, t.org.id, endpoint.id, { headers: {} });
    expect(cleared.endpoint.headerNames).toEqual([]);
    expect(row(t, 'SELECT headers_enc FROM webhook_endpoints WHERE id = ?', endpoint.id).headers_enc).toBeNull();
  });

  it('does nothing for an empty change', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, {});
    expect((await updateEndpoint(t.env, t.org.id, endpoint.id, {})).changed).toEqual([]);
  });

  it('pauses and resumes, and lets only active or paused be set', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, {});
    expect((await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' })).endpoint.status).toBe('paused');
    expect((await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'active' })).endpoint.status).toBe('active');
    expect((await failure(() => updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'disabled' }))).fields).toHaveProperty('status');
  });

  it('turning a disabled endpoint back on clears the reason and the streak', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, {});
    t.sqlite
      .prepare(`UPDATE webhook_endpoints SET status = 'disabled', disabled_reason = 'It kept failing.', consecutive_failures = 40, failing_since = 1000 WHERE id = ?`)
      .run(endpoint.id);
    const { endpoint: back } = await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'active' });
    expect(back).toMatchObject({ status: 'active', disabledReason: null, consecutiveFailures: 0 });
    expect(row(t, 'SELECT failing_since FROM webhook_endpoints WHERE id = ?', endpoint.id).failing_since).toBeNull();
  });

  it('keeps one workspace out of another', async () => {
    const t = createTestEnv();
    const { endpoint } = await create(t, {});
    expect((await failure(() => getEndpoint(t.env, 'org_other', endpoint.id))).code).toBe('not_found');
    expect((await failure(() => updateEndpoint(t.env, 'org_other', endpoint.id, { name: 'x' }))).code).toBe('not_found');
    expect((await failure(() => deleteEndpoint(t.env, 'org_other', endpoint.id))).code).toBe('not_found');
    expect((await failure(() => rotateEndpointSecret(t.env, 'org_other', endpoint.id))).code).toBe('not_found');
    expect((await failure(() => revealEndpointSecret(t.env, 'org_other', endpoint.id))).code).toBe('not_found');
  });
});

describe('deleting an endpoint', () => {
  it('removes its deliveries and attempts, and no one else’s', async () => {
    const t = createTestEnv();
    stubFetch();
    const a = await addEndpoint(t, { name: 'A' });
    await addEndpoint(t, { name: 'B', events: ['forms.*'] });
    const { deliverWebhook } = await import('../../src/core/webhooks');
    const [deliveryId] = await makeDeliveries(t);
    await deliverWebhook(t.env, deliveryId!);
    await makeDeliveries(t, { type: 'forms.form.submitted' });
    // The forms event reaches both endpoints (A listens to everything), the links event only A.
    expect(rows(t, 'SELECT id FROM webhook_deliveries')).toHaveLength(3);

    await deleteEndpoint(t.env, t.org.id, a.endpoint.id);
    expect(rows(t, 'SELECT endpoint_id FROM webhook_deliveries')).toHaveLength(1);
    expect(rows(t, 'SELECT id FROM webhook_attempts')).toHaveLength(0);
    expect(await listEndpoints(t.env, t.org.id)).toHaveLength(1);
  });
});

describe('the secret', () => {
  it('rotates to a new secret and lets the old one sign for 24 hours', async () => {
    const t = createTestEnv();
    const { endpoint, secret } = await create(t, {});
    const now = Date.UTC(2026, 0, 15, 12);
    const rotated = await rotateEndpointSecret(t.env, t.org.id, endpoint.id, now);
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(secret);
    expect(rotated.previousSecretExpiresAt).toBe(now + 24 * 3600 * 1000);
    expect(rotated.endpoint.previousSecretExpiresAt).toBe(now + 24 * 3600 * 1000);
    expect((await revealEndpointSecret(t.env, t.org.id, endpoint.id)).secret).toBe(rotated.secret);
    expect(JSON.stringify(rows(t, 'SELECT * FROM webhook_endpoints'))).not.toContain(secret.slice(6));
  });
});

describe('deleting a workspace', () => {
  it('removes its endpoints, deliveries and attempts and leaves other workspaces alone', async () => {
    const t = createTestEnv();
    stubFetch();
    await create(t, {});
    await createEndpoint(t.env, 'org_other', ADMIN, { name: 'Theirs', url: RECEIVER, events: ['*'] });
    await purgeOrgData(t.env, t.org.id);
    expect(await listEndpoints(t.env, t.org.id)).toEqual([]);
    expect(await listEndpoints(t.env, 'org_other')).toHaveLength(1);
    for (const table of ['webhook_deliveries', 'webhook_attempts']) {
      const left = await t.env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE org_id = ?1`).bind(t.org.id).first<{ n: number }>();
      expect(left?.n, table).toBe(0);
    }
  });
});
