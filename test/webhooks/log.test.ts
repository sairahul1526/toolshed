import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverWebhook, getDelivery, listDeliveries } from '../../src/core/webhooks';
import { purgeOldDeliveries } from '../../src/core/webhooks/log';
import { createTestEnv } from '../helpers/d1';
import { failure } from '../keys/helpers';
import { addEndpoint, makeDeliveries, rows, stubFetch } from './helpers';

const NOW = Date.UTC(2026, 0, 15, 12);
const DAY = 86_400_000;

afterEach(() => vi.unstubAllGlobals());

describe('listing deliveries', () => {
  it('pages newest first with a cursor, with no repeats and nothing missed', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const made: string[] = [];
    for (let i = 0; i < 7; i++) made.push(...(await makeDeliveries(t, {}, NOW + i * 1000)));

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await listDeliveries(t.env, t.org.id, { limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.deliveries.map((d) => d.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toEqual([...made].reverse());
    expect(new Set(seen).size).toBe(7);
  });

  it('gives no cursor when everything fits on one page', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await makeDeliveries(t, {}, NOW);
    const page = await listDeliveries(t.env, t.org.id, {});
    expect(page.deliveries).toHaveLength(1);
    expect(page.nextCursor).toBeNull();
    expect(page.deliveries[0]).toMatchObject({ eventType: 'links.link.clicked', status: 'pending', attemptCount: 0 });
  });

  it('filters by endpoint, status and event', async () => {
    stubFetch((s) => new Response('', { status: s.body.includes('links.link.created') ? 500 : 200 }));
    const t = createTestEnv();
    const a = await addEndpoint(t, { name: 'A', events: ['*'] });
    const b = await addEndpoint(t, { name: 'B', events: ['forms.*'] });
    const [clicked] = await makeDeliveries(t, { type: 'links.link.clicked' }, NOW);
    const [created] = await makeDeliveries(t, { type: 'links.link.created' }, NOW + 1000);
    const submitted = await makeDeliveries(t, { type: 'forms.form.submitted' }, NOW + 2000);
    await deliverWebhook(t.env, clicked!, NOW);
    await deliverWebhook(t.env, created!, NOW);

    const ids = async (q: Record<string, string>) => (await listDeliveries(t.env, t.org.id, q)).deliveries.map((d) => d.id).sort();
    expect(await ids({ endpoint: b.endpoint.id })).toEqual([submitted[1]!]);
    expect((await ids({ endpoint: a.endpoint.id })).length).toBe(3);
    expect(await ids({ status: 'success' })).toEqual([clicked!]);
    expect(await ids({ status: 'pending' })).toEqual([created!, ...submitted].sort());
    expect(await ids({ event: 'links.link.created' })).toEqual([created!]);
    expect(await ids({ endpoint: a.endpoint.id, status: 'success', event: 'links.link.clicked' })).toEqual([clicked!]);
    expect(await ids({ status: 'failed' })).toEqual([]);
  });

  it('stays inside the workspace', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await addEndpoint(t, {}, 'org_other');
    await makeDeliveries(t, { orgId: 'org_other' }, NOW);
    expect((await listDeliveries(t.env, t.org.id, {})).deliveries).toHaveLength(0);
    expect((await listDeliveries(t.env, 'org_other', {})).deliveries).toHaveLength(1);
  });

  it.each([
    [{ limit: '0' }, 'limit'],
    [{ limit: '101' }, 'limit'],
    [{ limit: 'many' }, 'limit'],
    [{ cursor: 'nope' }, 'cursor'],
    [{ status: 'done' }, 'status'],
    [{ endpoint: 'x' }, 'endpoint'],
  ])('refuses %j', async (query, field) => {
    const t = createTestEnv();
    const err = await failure(() => listDeliveries(t.env, t.org.id, query));
    expect(err.code).toBe('validation_failed');
    expect(err.fields).toHaveProperty(field);
  });
});

describe('one delivery', () => {
  it('shows the payload and every try', async () => {
    let status = 500;
    stubFetch(() => new Response('try later', { status }));
    const t = createTestEnv();
    await addEndpoint(t);
    const [id] = await makeDeliveries(t, {}, NOW);
    await deliverWebhook(t.env, id!, NOW);
    status = 200;
    await deliverWebhook(t.env, id!, NOW + 30_000);

    const d = await getDelivery(t.env, t.org.id, id!);
    expect(d).toMatchObject({ id, status: 'success', attemptCount: 2, payload: { type: 'links.link.clicked', data: { slug: 'sale' } } });
    expect(d.attempts).toHaveLength(2);
    expect(d.attempts[0]).toMatchObject({ attempt: 1, statusCode: 500, errorCode: 'http_500', responseSnippet: 'try later', at: NOW });
    expect(d.attempts[1]).toMatchObject({ attempt: 2, statusCode: 200, errorCode: null, at: NOW + 30_000 });
    expect(typeof d.attempts[0]!.durationMs).toBe('number');
  });

  it('is not found in another workspace or when the id is wrong', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const [id] = await makeDeliveries(t, {}, NOW);
    expect((await failure(() => getDelivery(t.env, 'org_other', id!))).code).toBe('not_found');
    expect((await failure(() => getDelivery(t.env, t.org.id, 'whd_missing'))).code).toBe('not_found');
  });
});

describe('the 30 day clean-up', () => {
  it('removes old deliveries and their tries and keeps newer ones', async () => {
    stubFetch();
    const t = createTestEnv();
    await addEndpoint(t);
    const [old] = await makeDeliveries(t, {}, NOW - 31 * DAY);
    const [edge] = await makeDeliveries(t, {}, NOW - 29 * DAY);
    const [fresh] = await makeDeliveries(t, {}, NOW - DAY);
    // Each try is made when its delivery was made, as it would be for real.
    for (const [id, age] of [[old, 31], [edge, 29], [fresh, 1]] as const) await deliverWebhook(t.env, id!, NOW - age * DAY);
    expect(rows(t, 'SELECT id FROM webhook_attempts')).toHaveLength(3);

    expect(await purgeOldDeliveries(t.env, NOW)).toBe(1);
    expect(rows<{ id: string }>(t, 'SELECT id FROM webhook_deliveries ORDER BY id').map((r) => r.id)).toEqual([edge, fresh].sort());
    expect(rows(t, 'SELECT delivery_id FROM webhook_attempts')).toHaveLength(2);
    expect(await purgeOldDeliveries(t.env, NOW)).toBe(0);
  });

  it('works through more than one slice', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const insert = t.sqlite.prepare(
      `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, message_id, event_type, status, attempt_count, payload, created_at, updated_at)
       VALUES (?, 'org_test', 'whe_x', ?, 'a.b', 'failed', 1, '{}', ?, ?)`,
    );
    for (let i = 0; i < 1500; i++) insert.run(`whd_old${i}`, `evt_${i}`, NOW - 40 * DAY, NOW - 40 * DAY);
    expect(await purgeOldDeliveries(t.env, NOW)).toBe(1500);
    expect(rows(t, 'SELECT id FROM webhook_deliveries')).toHaveLength(0);
  });
});
