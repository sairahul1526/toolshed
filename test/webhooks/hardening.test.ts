/** Fixes from the review of the webhooks service: headers, failure streaks, large payloads, own address, rotation, clean-up, tests left pending. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverWebhook, rotateEndpointSecret, sendTestEvent, sweepDeliveries, updateEndpoint } from '../../src/core/webhooks';
import { queueWebhooks } from '../../src/core/webhooks/fanout';
import { purgeOldDeliveries } from '../../src/core/webhooks/log';
import { RETRY_HORIZON_MS } from '../../src/core/webhooks/types';
import { createTestEnv } from '../helpers/d1';
import { failure } from '../keys/helpers';
import { addEndpoint, makeDeliveries, row, rows, stubFetch } from './helpers';

const NOW = Date.UTC(2026, 0, 15, 12);
const HOUR = 3600_000;
const DAY = 24 * HOUR;

afterEach(() => vi.unstubAllGlobals());

const endpointRow = (t: ReturnType<typeof createTestEnv>, id: string) => row(t, 'SELECT * FROM webhook_endpoints WHERE id = ?', id);

describe('custom header values', () => {
  it.each([
    ['an emoji', 'token 🙂'],
    ['Chinese', '令牌'],
    ['a letter above U+00FF', 'Łódź'],
  ])('refuses %s with an error on that header', async (_label, value) => {
    const t = createTestEnv();
    const err = await failure(() => addEndpoint(t, { headers: { 'X-Token': value } }));
    expect(err.code).toBe('validation_failed');
    expect(err.fields?.['headers.X-Token']).toContain('Latin');
  });

  it('refuses them on update too, and still allows Latin-1 text', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    expect((await failure(() => updateEndpoint(t.env, t.org.id, endpoint.id, { headers: { 'X-Token': '令牌' } }))).fields).toHaveProperty('headers.X-Token');
    const ok = await updateEndpoint(t.env, t.org.id, endpoint.id, { headers: { 'X-Name': 'café' } });
    expect(ok.endpoint.headerNames).toEqual(['X-Name']);
  });

  it('fails the try, and sends nothing, when the sealed headers cannot be opened', async () => {
    const sent = stubFetch();
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t, { headers: { Authorization: 'Bearer abc' } });
    const [deliveryId] = await makeDeliveries(t, {}, NOW);
    t.sqlite.prepare("UPDATE webhook_endpoints SET headers_enc = 'v1.broken' WHERE id = ?").run(endpoint.id);
    const result = await deliverWebhook(t.env, deliveryId!, NOW);
    expect(result).toMatchObject({ ok: false, statusCode: null, errorCode: 'headers_unreadable' });
    expect(sent).toHaveLength(0);
    expect(row(t, 'SELECT status, last_error FROM webhook_deliveries WHERE id = ?', deliveryId!)).toMatchObject({ status: 'pending', last_error: 'headers_unreadable' });
  });
});

describe('the failure streak', () => {
  async function failOnce(t: ReturnType<typeof createTestEnv>, at: number) {
    const [id] = await makeDeliveries(t, {}, at);
    await deliverWebhook(t.env, id!, at);
  }

  it('starts a new streak for a failure that comes after the whole retry schedule', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    await failOnce(t, NOW);
    await failOnce(t, NOW + 2 * HOUR);
    expect(endpointRow(t, endpoint.id)).toMatchObject({ consecutive_failures: 2, failing_since: NOW });

    // A quiet week, then one failure: it is the start of something new, not the 3rd day of the old streak.
    const later = NOW + 7 * DAY;
    await failOnce(t, later);
    expect(endpointRow(t, endpoint.id)).toMatchObject({ status: 'active', consecutive_failures: 1, failing_since: later });
  });

  it('keeps one streak while failures are no further apart than the retry schedule', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    await failOnce(t, NOW);
    await failOnce(t, NOW + RETRY_HORIZON_MS);
    expect(endpointRow(t, endpoint.id)).toMatchObject({ consecutive_failures: 2, failing_since: NOW });
  });

  it('still turns an endpoint off after 72 hours of failures that keep coming', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    for (let hours = 0; hours <= 72; hours += 12) await failOnce(t, NOW + hours * HOUR);
    expect(endpointRow(t, endpoint.id).status).toBe('disabled');
  });

  it('is cleared when the address changes', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    t.sqlite.prepare('UPDATE webhook_endpoints SET consecutive_failures = 12, failing_since = ?, last_failure_at = ? WHERE id = ?').run(NOW, NOW, endpoint.id);
    await updateEndpoint(t.env, t.org.id, endpoint.id, { name: 'Renamed' });
    expect(endpointRow(t, endpoint.id).consecutive_failures).toBe(12);
    await updateEndpoint(t.env, t.org.id, endpoint.id, { url: 'https://other.example.com/in' });
    expect(endpointRow(t, endpoint.id)).toMatchObject({ consecutive_failures: 0, failing_since: null });
  });

  it('is cleared when a paused endpoint is turned back on', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' });
    t.sqlite.prepare('UPDATE webhook_endpoints SET consecutive_failures = 12, failing_since = ? WHERE id = ?').run(NOW, endpoint.id);
    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'active' });
    expect(endpointRow(t, endpoint.id)).toMatchObject({ status: 'active', consecutive_failures: 0, failing_since: null });
  });
});

describe('large events with non-ASCII data', () => {
  const clicked = (data: Record<string, unknown>) => ({ orgId: 'org_test', module: 'links', name: 'link.clicked', subject: 'lnk_1', data });
  const queuedData = (t: ReturnType<typeof createTestEnv>) => (t.queue.sent[0]!.body.payload as { data: unknown }).data;

  it('measures bytes, so CJK text over the queue limit takes the too-large path', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    // 50,000 characters is under 100 KB as a string but about 150 KB in UTF-8.
    const text = '令'.repeat(50_000);
    expect(JSON.stringify({ text }).length).toBeLessThan(100 * 1024);
    await queueWebhooks(t.env, clicked({ text }));
    expect(t.queue.sent).toHaveLength(1);
    expect(queuedData(t)).toEqual({ truncated: true });
  });

  it('counts emoji at four bytes each', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    await queueWebhooks(t.env, clicked({ text: '🙂'.repeat(30_000) }));
    expect(queuedData(t)).toEqual({ truncated: true });
  });

  it('keeps non-ASCII data that fits', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const data = { text: '令'.repeat(20_000) };
    await queueWebhooks(t.env, clicked(data));
    expect(queuedData(t)).toEqual(data);
  });
});

describe('an address that is this install', () => {
  const withAppUrl = (t: ReturnType<typeof createTestEnv>, appUrl: string) => ({ ...t, env: { ...t.env, APP_URL: appUrl } });

  it.each([
    ['the same host', 'https://toolshed.example.com/api/v1/anything'],
    ['the same host in capitals', 'https://TOOLSHED.example.com/x'],
    ['the same host with a trailing dot', 'https://toolshed.example.com./x'],
  ])('is refused on create for %s', async (_label, url) => {
    const t = withAppUrl(createTestEnv(), 'https://toolshed.example.com');
    const err = await failure(() => addEndpoint(t, { url }));
    expect(err.code).toBe('validation_failed');
    expect(err.fields?.url).toContain('this Toolshed install');
  });

  it('is refused on update', async () => {
    const t = withAppUrl(createTestEnv(), 'https://toolshed.example.com/app');
    const { endpoint } = await addEndpoint(t);
    const err = await failure(() => updateEndpoint(t.env, t.org.id, endpoint.id, { url: 'https://toolshed.example.com/hook' }));
    expect(err.fields).toHaveProperty('url');
  });

  it('allows another host, another port and an unset APP_URL', async () => {
    const t = withAppUrl(createTestEnv(), 'https://toolshed.example.com');
    await addEndpoint(t, { url: 'https://hooks.example.com/in' });
    await addEndpoint(t, { url: 'https://toolshed.example.com:8443/in' });
    const bare = createTestEnv();
    delete (bare.env as { APP_URL?: string }).APP_URL;
    await addEndpoint(bare, { url: 'https://toolshed.example.com/in' });
  });

  it('is refused at send, without calling out, when the row already points there', async () => {
    const sent = stubFetch();
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    const [deliveryId] = await makeDeliveries(t, {}, NOW);
    t.sqlite.prepare('UPDATE webhook_endpoints SET url = ? WHERE id = ?').run('https://toolshed.example.com/loop', endpoint.id);
    const result = await deliverWebhook({ ...t.env, APP_URL: 'https://toolshed.example.com' }, deliveryId!, NOW);
    expect(result).toMatchObject({ ok: false, errorCode: 'url_not_allowed' });
    expect(sent).toHaveLength(0);
  });
});

describe('making a new secret', () => {
  it('gives up with a conflict when the secret changed since it was read', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    // Someone else rotates in the moment between our read and our write.
    const db = Object.create(t.env.DB) as D1Database;
    let raced = false;
    db.prepare = (text: string) => {
      if (!raced && text.startsWith('UPDATE webhook_endpoints SET secret_enc')) {
        raced = true;
        t.sqlite.prepare("UPDATE webhook_endpoints SET secret_enc = 'v1.rival' WHERE id = ?").run(endpoint.id);
      }
      return t.env.DB.prepare(text);
    };
    const err = await failure(() => rotateEndpointSecret({ ...t.env, DB: db }, t.org.id, endpoint.id, NOW));
    expect(err.code).toBe('conflict');
    expect(err.message).toContain('just changed');
    expect(endpointRow(t, endpoint.id)).toMatchObject({ secret_enc: 'v1.rival', prev_secret_enc: null });
  });

  it('still says not found for an endpoint that is gone', async () => {
    const t = createTestEnv();
    expect((await failure(() => rotateEndpointSecret(t.env, t.org.id, 'whe_missing', NOW))).code).toBe('not_found');
  });

  it('keeps the old secret as the previous one', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    const before = endpointRow(t, endpoint.id).secret_enc;
    await rotateEndpointSecret(t.env, t.org.id, endpoint.id, NOW);
    expect(endpointRow(t, endpoint.id)).toMatchObject({ prev_secret_enc: before, prev_secret_expires_at: NOW + DAY });
  });
});

describe('the clean-up', () => {
  const insertAttempt = (t: ReturnType<typeof createTestEnv>, id: string, deliveryId: string, at: number) =>
    t.sqlite
      .prepare(`INSERT INTO webhook_attempts (id, org_id, delivery_id, attempt, duration_ms, created_at) VALUES (?, 'org_test', ?, 1, 5, ?)`)
      .run(id, deliveryId, at);

  it('removes old attempts whose delivery is already gone, and keeps recent ones', async () => {
    const t = createTestEnv();
    insertAttempt(t, 'wha_orphan_old', 'whd_gone', NOW - 40 * DAY);
    insertAttempt(t, 'wha_orphan_new', 'whd_gone', NOW - 2 * DAY);
    await purgeOldDeliveries(t.env, NOW);
    expect(rows<{ id: string }>(t, 'SELECT id FROM webhook_attempts').map((r) => r.id)).toEqual(['wha_orphan_new']);
  });

  it('clears more than one slice of orphans', async () => {
    const t = createTestEnv();
    for (let i = 0; i < 2500; i++) insertAttempt(t, `wha_o${i}`, 'whd_gone', NOW - 40 * DAY);
    await purgeOldDeliveries(t.env, NOW);
    expect(rows(t, 'SELECT id FROM webhook_attempts')).toHaveLength(0);
  });

  it('is not capped at 50,000 in one run: it goes through 20 slices of 1,000 and carries on next run', async () => {
    const t = createTestEnv();
    await addEndpoint(t);
    const insert = t.sqlite.prepare(
      `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, message_id, event_type, status, attempt_count, payload, created_at, updated_at)
       VALUES (?, 'org_test', 'whe_x', ?, 'a.b', 'failed', 1, '{}', ?, ?)`,
    );
    for (let i = 0; i < 21_500; i++) insert.run(`whd_old${i}`, `evt_${i}`, NOW - 40 * DAY, NOW - 40 * DAY);
    expect(await purgeOldDeliveries(t.env, NOW)).toBe(20_000);
    expect(await purgeOldDeliveries(t.env, NOW)).toBe(1_500);
    expect(rows(t, 'SELECT id FROM webhook_deliveries')).toHaveLength(0);
  });
});

describe('a test event that is never settled', () => {
  it('is pending with a due time while its try is in flight', async () => {
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    let seen: Record<string, unknown> | undefined;
    stubFetch(() => {
      seen = row(t, "SELECT status, next_attempt_at FROM webhook_deliveries WHERE event_type = 'webhook.test'");
      return new Response('ok');
    });
    await sendTestEvent(t.env, t.org.id, endpoint.id, NOW);
    expect(seen).toMatchObject({ status: 'pending', next_attempt_at: NOW + 10 * 60_000 });
    expect(row(t, "SELECT status, next_attempt_at FROM webhook_deliveries WHERE event_type = 'webhook.test'")).toMatchObject({ status: 'success', next_attempt_at: null });
  });

  it('is closed by the sweeper once it is long overdue, and never sent again', async () => {
    const sent = stubFetch();
    const t = createTestEnv();
    const { endpoint } = await addEndpoint(t);
    // The isolate died after the row was written: nothing settled it.
    t.sqlite
      .prepare(
        `INSERT INTO webhook_deliveries (id, org_id, endpoint_id, message_id, event_type, status, attempt_count, next_attempt_at, payload, created_at, updated_at)
         VALUES ('whd_test1', 'org_test', ?, 'evt_t1', 'webhook.test', 'pending', 1, ?, '{}', ?, ?)`,
      )
      .run(endpoint.id, NOW + 10 * 60_000, NOW, NOW);
    expect(await sweepDeliveries(t.env, NOW + 12 * 60_000)).toBe(0);
    expect(row(t, "SELECT status FROM webhook_deliveries WHERE id = 'whd_test1'").status).toBe('pending');

    expect(await sweepDeliveries(t.env, NOW + 16 * 60_000)).toBe(0);
    expect(row(t, "SELECT * FROM webhook_deliveries WHERE id = 'whd_test1'")).toMatchObject({ status: 'failed', last_error: 'test_interrupted', next_attempt_at: null });
    expect(t.queue.sent).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });
});
