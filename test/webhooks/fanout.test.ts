import { afterEach, describe, expect, it, vi } from 'vitest';
import { emit } from '../../src/core/events';
import { defineModule } from '../../src/core/module';
import { registerModules } from '../../src/core/registry';
import { eventCatalog } from '../../src/core/webhooks/catalog';
import { fanOut, queueWebhooks } from '../../src/core/webhooks/fanout';
import { updateEndpoint } from '../../src/core/webhooks';
import { createTestEnv } from '../helpers/d1';
import { coldInstance } from '../keys/helpers';
import { addEndpoint, job, recordSql, row, rows, stubFetch } from './helpers';

const NOW = Date.UTC(2026, 0, 15, 12);

const base = { version: '1.0.0' as const, category: 'growth' as const, icon: 'x', permissions: [] };
const links = defineModule({ ...base, id: 'links', name: 'Links', description: 'Short links.', events: { emits: ['link.created', 'link.clicked'] } });
const forms = defineModule({ ...base, id: 'forms', name: 'Forms', description: 'Forms.', events: { emits: ['form.submitted'] } });
const quiet = defineModule({ ...base, id: 'quiet', name: 'Quiet', description: 'Emits nothing.' });

afterEach(() => {
  registerModules([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clicked = { orgId: 'org_test', module: 'links', name: 'link.clicked', subject: 'lnk_1', data: { slug: 'sale' } };

describe('the event catalog', () => {
  it('lists what modules say they emit, sorted, with the module name', () => {
    registerModules([links, forms, quiet]);
    expect(eventCatalog()).toEqual([
      { type: 'forms.form.submitted', module: 'forms', moduleName: 'Forms' },
      { type: 'links.link.clicked', module: 'links', moduleName: 'Links' },
      { type: 'links.link.created', module: 'links', moduleName: 'Links' },
    ]);
  });
});

describe('a workspace with no webhooks', () => {
  it('costs one lookup the first time and nothing after, and queues nothing', async () => {
    const t = createTestEnv();
    const cold = coldInstance(t.env);
    await queueWebhooks(cold.env, clicked);
    expect(cold.queries()).toBe(1);
    for (let i = 0; i < 5; i++) await queueWebhooks(cold.env, clicked);
    expect(cold.queries()).toBe(1);
    expect(t.queue.sent).toHaveLength(0);
  });

  it('is not slowed by emit beyond that one lookup', async () => {
    const t = createTestEnv();
    const rec = recordSql(t.env);
    await emit(rec.env, clicked);
    expect(rec.sql.filter((q) => q.includes('webhook_endpoints'))).toHaveLength(1);
    const before = rec.sql.length;
    await emit(rec.env, clicked);
    // The second emit does its own two counting writes and nothing for webhooks.
    expect(rec.sql.slice(before)).toHaveLength(2);
    expect(rec.sql.slice(before).join(' ')).not.toContain('webhook');
    expect(t.queue.sent.filter((m) => m.body.name === 'core.webhook.fanout')).toHaveLength(0);
  });

  it('knows about a workspace that is paused or has only paused endpoints', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' });
    await queueWebhooks(t.env, clicked);
    expect(t.queue.sent).toHaveLength(0);
  });
});

describe('queueing an event', () => {
  it('puts one fan-out job on the queue when an endpoint is active', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await addEndpoint(t, { name: 'Second' });
    await queueWebhooks(t.env, { ...clicked, at: NOW });
    expect(t.queue.sent).toHaveLength(1);
    const [msg] = t.queue.sent;
    expect(msg!.body.name).toBe('core.webhook.fanout');
    expect(msg!.body.payload).toMatchObject({ orgId: 'org_test', type: 'links.link.clicked', subject: 'lnk_1', data: { slug: 'sale' }, at: NOW });
    expect((msg!.body.payload as { id: string }).id).toMatch(/^evt_/);
  });

  it('drops a very large data object so the queue message stays small', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await queueWebhooks(t.env, { ...clicked, data: { blob: 'x'.repeat(150 * 1024) } });
    expect((t.queue.sent[0]!.body.payload as { data: unknown }).data).toEqual({ truncated: true });
  });

  it('never throws when the queue is down', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const env = { ...t.env, JOBS: { send: async () => Promise.reject(new Error('queue down')) } as unknown as typeof t.env.JOBS };
    await expect(queueWebhooks(env, clicked)).resolves.toBeUndefined();
    await expect(emit(env, clicked)).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });

  it('runs from emit through to a signed post', async () => {
    const sent = stubFetch();
    const t = createTestEnv();
    const { secret } = await addEndpoint(t, { events: ['links.*'] });
    await emit(t.env, { ...clicked, at: Date.now() });
    await t.drainJobs();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: 'links.link.clicked', subject: 'lnk_1', workspace_id: 'org_test', data: { slug: 'sale' } });
    expect(secret).toMatch(/^whsec_/);
    expect(row(t, 'SELECT status FROM webhook_deliveries').status).toBe('success');
  });
});

describe('making deliveries', () => {
  it('makes one for each endpoint whose patterns match', async () => {
    const t = createTestEnv();
    const exact = await addEndpoint(t, { name: 'Exact', events: ['links.link.clicked'] });
    const module = await addEndpoint(t, { name: 'Module', events: ['links.*'] });
    const all = await addEndpoint(t, { name: 'All', events: ['*'] });
    await addEndpoint(t, { name: 'Other event', events: ['links.link.created'] });
    await addEndpoint(t, { name: 'Other module', events: ['forms.*'] });

    const made = await fanOut(t.env, job(), NOW);
    expect(made).toBe(3);
    const got = rows<{ endpoint_id: string }>(t, 'SELECT endpoint_id FROM webhook_deliveries').map((r) => r.endpoint_id).sort();
    expect(got).toEqual([exact.endpoint.id, module.endpoint.id, all.endpoint.id].sort());
    expect(t.queue.sent.filter((m) => m.body.name === 'core.webhook.deliver')).toHaveLength(3);
  });

  it('skips paused and off endpoints and other workspaces', async () => {
    const t = createTestEnv();
    await addEndpoint(t, { name: 'On' });
    const paused = await addEndpoint(t, { name: 'Paused' });
    await updateEndpoint(t.env, t.org.id, paused.endpoint.id, { status: 'paused' });
    const off = await addEndpoint(t, { name: 'Off' });
    t.sqlite.prepare("UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ?").run(off.endpoint.id);
    await addEndpoint(t, { name: 'Elsewhere' }, 'org_other');

    expect(await fanOut(t.env, job(), NOW)).toBe(1);
    expect(rows(t, 'SELECT org_id FROM webhook_deliveries')).toEqual([{ org_id: 'org_test' }]);
  });

  it('makes nothing when no pattern matches', async () => {
    const t = createTestEnv();
    await addEndpoint(t, { events: ['forms.*'] });
    expect(await fanOut(t.env, job(), NOW)).toBe(0);
    expect(t.queue.sent).toHaveLength(0);
  });

  it('uses one query to find endpoints and one write per delivery, however many there are', async () => {
    const t = createTestEnv();
    for (let i = 0; i < 6; i++) await addEndpoint(t, { name: `Endpoint ${i}` });
    const rec = recordSql(t.env);
    await fanOut(rec.env, job(), NOW);
    expect(rec.sql.filter((q) => q.includes('FROM webhook_endpoints'))).toHaveLength(1);
    expect(rec.sql.filter((q) => q.includes('INTO webhook_deliveries'))).toHaveLength(6);
    expect(rec.sql).toHaveLength(7);
  });

  it('makes each delivery only once when the same job runs again', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await addEndpoint(t, { name: 'Second' });
    const same = job();
    expect(await fanOut(t.env, same, NOW)).toBe(2);
    t.queue.sent.length = 0;
    expect(await fanOut(t.env, same, NOW + 1000)).toBe(0);
    expect(rows(t, 'SELECT id FROM webhook_deliveries')).toHaveLength(2);
    expect(t.queue.sent).toHaveLength(0);
  });

  it('stores the payload with the id as the message id', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const j = job({ subject: null, data: { a: 1 } });
    await fanOut(t.env, j, NOW);
    const stored = row(t, 'SELECT * FROM webhook_deliveries');
    expect(stored).toMatchObject({ message_id: j.id, event_type: 'links.link.clicked', status: 'pending', attempt_count: 0, org_id: 'org_test' });
    expect(JSON.parse(stored.payload)).toEqual({
      id: j.id,
      type: 'links.link.clicked',
      timestamp: new Date(j.at).toISOString(),
      workspace_id: 'org_test',
      subject: null,
      data: { a: 1 },
    });
  });

  it('replaces data with a marker when the body would pass 256 KB', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await fanOut(t.env, job({ data: { blob: 'x'.repeat(300 * 1024) } }), NOW);
    const payload = row(t, 'SELECT payload FROM webhook_deliveries').payload as string;
    expect(JSON.parse(payload).data).toEqual({ truncated: true });
    expect(new TextEncoder().encode(payload).length).toBeLessThanOrEqual(256 * 1024);
  });

  it('keeps data just under the limit', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await fanOut(t.env, job({ data: { blob: 'x'.repeat(200 * 1024) } }), NOW);
    const payload = JSON.parse(row(t, 'SELECT payload FROM webhook_deliveries').payload);
    expect(payload.data.blob).toHaveLength(200 * 1024);
  });
});
