import { afterEach, describe, expect, it, vi } from 'vitest';
import { runJob } from '../../src/core/jobs';
import { deliverWebhook, resendDelivery, rotateEndpointSecret, sendTestEvent, sweepDeliveries, updateEndpoint, verifySignature } from '../../src/core/webhooks';
import { forgetActiveEndpoints, hasActiveEndpoints } from '../../src/core/webhooks/active';
import { createTestEnv } from '../helpers/d1';
import { failure } from '../keys/helpers';
import { addEndpoint, makeDeliveries, row, rows, stubFetch } from './helpers';

const NOW = Date.UTC(2026, 0, 15, 12);
const HOUR = 3600_000;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function setup(input: Record<string, unknown> = {}) {
  const t = createTestEnv();
  const made = await addEndpoint(t, input);
  const [deliveryId] = await makeDeliveries(t, {}, NOW);
  t.queue.sent.length = 0;
  return { t, ...made, deliveryId: deliveryId! };
}

const deliveryRow = (t: ReturnType<typeof createTestEnv>, id: string) => row(t, 'SELECT * FROM webhook_deliveries WHERE id = ?', id);

describe('a successful delivery', () => {
  it('sends a signed JSON post and records the win', async () => {
    const sent = stubFetch();
    const { t, endpoint, secret, deliveryId } = await setup({ headers: { 'X-Api-Token': 'private-token' } });
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result).toMatchObject({ ok: true, statusCode: 200, errorCode: null });

    expect(sent).toHaveLength(1);
    const [req] = sent;
    expect(req!.url).toBe('https://hooks.example.com/in');
    expect(req!.headers.get('content-type')).toBe('application/json');
    expect(req!.headers.get('user-agent')).toBe('Toolshed-Webhooks/1');
    expect(req!.headers.get('x-api-token')).toBe('private-token');
    expect(req!.headers.get('webhook-timestamp')).toBe(String(NOW / 1000));
    expect(req!.headers.get('webhook-id')).toMatch(/^evt_/);
    expect(await verifySignature(secret, req!.headers, req!.body, { now: NOW })).toBe(true);

    const body = JSON.parse(req!.body);
    expect(body).toEqual({
      id: req!.headers.get('webhook-id'),
      type: 'links.link.clicked',
      timestamp: new Date(NOW).toISOString(),
      workspace_id: 'org_test',
      subject: 'lnk_1',
      data: { slug: 'sale' },
    });

    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'success', attempt_count: 1, last_status_code: 200, next_attempt_at: null, completed_at: NOW });
    expect(row(t, 'SELECT * FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({ last_success_at: NOW, consecutive_failures: 0, failing_since: null });
    expect(rows(t, 'SELECT * FROM webhook_attempts')).toHaveLength(1);
    expect(t.queue.sent).toHaveLength(0);
  });

  it('keeps a success from being sent twice', async () => {
    const sent = stubFetch();
    const { t, deliveryId } = await setup();
    await deliverWebhook(t.env, deliveryId, NOW);
    expect(await deliverWebhook(t.env, deliveryId, NOW + 1000)).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('sends only once when the same job is handed out twice', async () => {
    const sent = stubFetch(() => new Response('no', { status: 500 }));
    const { t, deliveryId } = await setup();
    const a = deliverWebhook(t.env, deliveryId, NOW, 0);
    const b = deliverWebhook(t.env, deliveryId, NOW, 0);
    const out = await Promise.all([a, b]);
    expect(out.filter(Boolean)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(deliveryRow(t, deliveryId).attempt_count).toBe(1);
  });
});

describe('secret rotation', () => {
  it('signs with both secrets for 24 hours and then only the new one', async () => {
    const sent = stubFetch();
    const { t, endpoint, secret: oldSecret, deliveryId } = await setup();
    const rotated = await rotateEndpointSecret(t.env, t.org.id, endpoint.id, NOW);

    await deliverWebhook(t.env, deliveryId, NOW + HOUR);
    const first = sent[0]!.headers.get('webhook-signature')!.split(' ');
    expect(first).toHaveLength(2);
    expect(await verifySignature(oldSecret, sent[0]!.headers, sent[0]!.body, { now: NOW + HOUR })).toBe(true);
    expect(await verifySignature(rotated.secret, sent[0]!.headers, sent[0]!.body, { now: NOW + HOUR })).toBe(true);

    const [later] = await makeDeliveries(t, {}, NOW + 25 * HOUR);
    await deliverWebhook(t.env, later!, NOW + 25 * HOUR);
    const second = sent[1]!;
    expect(second.headers.get('webhook-signature')!.split(' ')).toHaveLength(1);
    expect(await verifySignature(rotated.secret, second.headers, second.body, { now: NOW + 25 * HOUR })).toBe(true);
    expect(await verifySignature(oldSecret, second.headers, second.body, { now: NOW + 25 * HOUR })).toBe(false);
  });

  it('lets a second rotation end the first overlap', async () => {
    const { t, endpoint, secret: first } = await setup();
    const second = await rotateEndpointSecret(t.env, t.org.id, endpoint.id, NOW);
    const third = await rotateEndpointSecret(t.env, t.org.id, endpoint.id, NOW + HOUR);
    const sent = stubFetch();
    const [id] = await makeDeliveries(t, {}, NOW + 2 * HOUR);
    await deliverWebhook(t.env, id!, NOW + 2 * HOUR);
    const h = sent[0]!.headers;
    expect(await verifySignature(third.secret, h, sent[0]!.body, { now: NOW + 2 * HOUR })).toBe(true);
    expect(await verifySignature(second.secret, h, sent[0]!.body, { now: NOW + 2 * HOUR })).toBe(true);
    expect(await verifySignature(first, h, sent[0]!.body, { now: NOW + 2 * HOUR })).toBe(false);
  });
});

describe('retries', () => {
  it('waits 30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours and 24 hours, then gives up after 7 tries', async () => {
    const sent = stubFetch(() => new Response('upstream broke', { status: 500 }));
    const { t, endpoint, deliveryId } = await setup();
    const expectedWaits = [30, 120, 600, 3600, 21600, 43200];
    let now = NOW;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const result = await deliverWebhook(t.env, deliveryId, now);
      expect(result).toMatchObject({ ok: false, statusCode: 500, errorCode: 'http_500', responseSnippet: 'upstream broke' });
      expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'pending', attempt_count: attempt, last_status_code: 500, last_error: 'http_500' });
      const queued = t.queue.sent.shift()!;
      expect(queued.body.name).toBe('core.webhook.deliver');
      expect(queued.delaySeconds).toBe(expectedWaits[attempt - 1]);
      const payload = queued.body.payload as { expect: number; dueAt: number; more: boolean };
      expect(payload.expect).toBe(attempt);
      expect(payload.more).toBe(attempt === 6);
      const fullWait = [30, 120, 600, 3600, 21600, 86400][attempt - 1]!;
      expect(payload.dueAt).toBe(now + fullWait * 1000);
      now = payload.dueAt;
    }
    const last = await deliverWebhook(t.env, deliveryId, now);
    expect(last?.ok).toBe(false);
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'failed', attempt_count: 7, next_attempt_at: null, completed_at: now });
    expect(t.queue.sent).toHaveLength(0);
    expect(sent).toHaveLength(7);
    expect(rows(t, 'SELECT attempt, error_code, response_snippet FROM webhook_attempts ORDER BY attempt')).toHaveLength(7);
    // The whole run took about 31 hours, so the endpoint is still on.
    expect(row(t, 'SELECT status, consecutive_failures FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({ status: 'active', consecutive_failures: 7 });
    expect(await deliverWebhook(t.env, deliveryId, now + 1000)).toBeNull();
  });

  it('waits out the 24 hour retry in two queue hops', async () => {
    stubFetch(() => new Response('', { status: 503 }));
    const { t, deliveryId } = await setup();
    let now = NOW;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await deliverWebhook(t.env, deliveryId, now);
      now = (t.queue.sent.shift()!.body.payload as { dueAt: number }).dueAt;
    }
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    await deliverWebhook(t.env, deliveryId, now);
    const first = t.queue.sent.shift()!;
    expect(first.delaySeconds).toBe(43200);
    expect((first.body.payload as { more: boolean }).more).toBe(true);
    const dueAt = (first.body.payload as { dueAt: number }).dueAt;
    expect(dueAt).toBe(now + 24 * HOUR);

    // Twelve hours later the job wakes, sees it is early and waits again for the rest.
    vi.setSystemTime(now + 12 * HOUR);
    await runJob(t.env, first.body);
    expect(deliveryRow(t, deliveryId).attempt_count).toBe(6);
    const second = t.queue.sent.shift()!;
    expect(second.delaySeconds).toBe(43200);
    expect((second.body.payload as { more: boolean }).more).toBe(false);

    // Twenty-four hours later it sends.
    const sent = stubFetch();
    vi.setSystemTime(dueAt);
    await runJob(t.env, second.body);
    expect(sent).toHaveLength(1);
    expect(deliveryRow(t, deliveryId).attempt_count).toBe(7);
  });

  it('retries on a network error and never throws', async () => {
    stubFetch(() => new Error('connection reset'));
    const { t, deliveryId } = await setup();
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result).toMatchObject({ ok: false, statusCode: null, errorCode: 'fetch_failed' });
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'pending', last_error: 'fetch_failed' });
    expect(t.queue.sent).toHaveLength(1);
  });

  it('does not follow a redirect', async () => {
    const sent = stubFetch(() => new Response(null, { status: 302, headers: { location: 'https://other.example.com/in' } }));
    const { t, deliveryId } = await setup();
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result?.errorCode).toBe('redirect_not_followed');
    expect(sent).toHaveLength(1);
  });

  it('keeps no more than 2 KB of the answer', async () => {
    stubFetch(() => new Response('x'.repeat(10_000), { status: 500 }));
    const { t, deliveryId } = await setup();
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result?.responseSnippet).toHaveLength(2048);
    expect(row(t, 'SELECT response_snippet FROM webhook_attempts').response_snippet).toHaveLength(2048);
  });

  it('refuses a private address that got into the row, without calling out', async () => {
    const sent = stubFetch();
    const { t, endpoint, deliveryId } = await setup();
    t.sqlite.prepare('UPDATE webhook_endpoints SET url = ? WHERE id = ?').run('https://169.254.169.254/latest', endpoint.id);
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result).toMatchObject({ ok: false, errorCode: 'url_not_allowed' });
    expect(sent).toHaveLength(0);
  });

  it('records a secret it cannot read instead of throwing', async () => {
    const sent = stubFetch();
    const { t, endpoint, deliveryId } = await setup();
    t.sqlite.prepare("UPDATE webhook_endpoints SET secret_enc = 'v1.broken' WHERE id = ?").run(endpoint.id);
    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result?.errorCode).toBe('secret_unreadable');
    expect(sent).toHaveLength(0);
  });
});

describe('turning an endpoint off', () => {
  it('turns it off at once on a 410 and tells the admins', async () => {
    stubFetch(() => new Response('gone', { status: 410 }));
    const { t, endpoint, deliveryId } = await setup();
    const [other] = await makeDeliveries(t, { type: 'links.link.created' }, NOW);
    t.queue.sent.length = 0;
    await hasActiveEndpoints(t.env, t.org.id, NOW);

    const result = await deliverWebhook(t.env, deliveryId, NOW);
    expect(result?.statusCode).toBe(410);
    expect(row(t, 'SELECT status, disabled_reason FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({
      status: 'disabled',
      disabled_reason: expect.stringContaining('410'),
    });
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'failed', next_attempt_at: null });
    expect(deliveryRow(t, other!)).toMatchObject({ status: 'failed', last_error: 'endpoint_disabled' });
    expect(t.queue.sent).toHaveLength(0);

    const note = row(t, 'SELECT * FROM notifications WHERE org_id = ?', t.org.id);
    expect(note).toMatchObject({ user_id: null, kind: 'webhooks', href: '/app/webhooks' });
    const log = row(t, "SELECT * FROM audit_log WHERE action = 'webhook.disabled'");
    expect(log).toMatchObject({ actor_type: 'system', target_id: endpoint.id, org_id: t.org.id });
    expect(JSON.stringify([note, log])).not.toContain('hooks.example.com');
    expect(await hasActiveEndpoints(t.env, t.org.id, NOW + 1)).toBe(false);
  });

  it('turns it off when it has failed for 72 hours in a row', async () => {
    stubFetch(() => new Response('', { status: 500 }));
    const { t, endpoint, deliveryId } = await setup();
    t.sqlite.prepare('UPDATE webhook_endpoints SET failing_since = ?, consecutive_failures = 90 WHERE id = ?').run(NOW - 71 * HOUR, endpoint.id);
    await deliverWebhook(t.env, deliveryId, NOW);
    expect(row(t, 'SELECT status FROM webhook_endpoints WHERE id = ?', endpoint.id).status).toBe('active');

    const [next] = await makeDeliveries(t, {}, NOW + 2 * HOUR);
    await deliverWebhook(t.env, next!, NOW + 2 * HOUR);
    expect(row(t, 'SELECT status, disabled_reason FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({
      status: 'disabled',
      disabled_reason: 'Every try failed for 3 days in a row.',
    });
    expect(rows(t, "SELECT id FROM audit_log WHERE action = 'webhook.disabled'")).toHaveLength(1);
    expect(rows(t, 'SELECT id FROM notifications')).toHaveLength(1);
  });

  it('starts the count again after a success', async () => {
    let status = 500;
    stubFetch(() => new Response('', { status }));
    const { t, endpoint, deliveryId } = await setup();
    t.sqlite.prepare('UPDATE webhook_endpoints SET failing_since = ? WHERE id = ?').run(NOW - 71 * HOUR, endpoint.id);
    status = 200;
    await deliverWebhook(t.env, deliveryId, NOW);
    expect(row(t, 'SELECT failing_since, consecutive_failures FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({ failing_since: null, consecutive_failures: 0 });

    status = 500;
    const [next] = await makeDeliveries(t, {}, NOW + 10 * HOUR);
    await deliverWebhook(t.env, next!, NOW + 10 * HOUR);
    expect(row(t, 'SELECT status, failing_since FROM webhook_endpoints WHERE id = ?', endpoint.id)).toMatchObject({ status: 'active', failing_since: NOW + 10 * HOUR });
  });

  it('is turned back on by hand, which clears the streak', async () => {
    stubFetch(() => new Response('', { status: 410 }));
    const { t, endpoint, deliveryId } = await setup();
    await deliverWebhook(t.env, deliveryId, NOW);
    const { endpoint: back } = await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'active' }, NOW + HOUR);
    expect(back).toMatchObject({ status: 'active', disabledReason: null, consecutiveFailures: 0 });
    expect(await hasActiveEndpoints(t.env, t.org.id, NOW + HOUR)).toBe(true);
  });

  it('does not send while the endpoint is paused or off', async () => {
    const sent = stubFetch();
    const { t, endpoint, deliveryId } = await setup();
    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' });
    expect(await deliverWebhook(t.env, deliveryId, NOW)).toBeNull();
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'failed', last_error: 'endpoint_paused' });
    expect(sent).toHaveLength(0);
  });

  it('fails a delivery whose endpoint is gone', async () => {
    const sent = stubFetch();
    const { t, endpoint, deliveryId } = await setup();
    t.sqlite.prepare('DELETE FROM webhook_endpoints WHERE id = ?').run(endpoint.id);
    expect(await deliverWebhook(t.env, deliveryId, NOW)).toBeNull();
    expect(deliveryRow(t, deliveryId).last_error).toBe('endpoint_deleted');
    expect(sent).toHaveLength(0);
  });
});

describe('the test event', () => {
  it('is sent now, signed, and shows in the log', async () => {
    const sent = stubFetch();
    const { t, endpoint, secret } = await setup();
    const { delivery, result } = await sendTestEvent(t.env, t.org.id, endpoint.id, NOW);
    expect(result.ok).toBe(true);
    expect(delivery).toMatchObject({ eventType: 'webhook.test', status: 'success', attemptCount: 1 });
    expect(await verifySignature(secret, sent[0]!.headers, sent[0]!.body, { now: NOW })).toBe(true);
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ type: 'webhook.test', subject: endpoint.id, workspace_id: 'org_test' });
    expect(rows(t, "SELECT id FROM webhook_deliveries WHERE event_type = 'webhook.test'")).toHaveLength(1);
  });

  it('works while the endpoint is paused', async () => {
    const sent = stubFetch();
    const { t, endpoint } = await setup();
    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' });
    expect((await sendTestEvent(t.env, t.org.id, endpoint.id, NOW)).result.ok).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('is refused when the endpoint is off', async () => {
    const sent = stubFetch();
    const { t, endpoint } = await setup();
    t.sqlite.prepare("UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ?").run(endpoint.id);
    const err = await failure(() => sendTestEvent(t.env, t.org.id, endpoint.id, NOW));
    expect(err.code).toBe('webhooks.endpoint_disabled');
    expect(sent).toHaveLength(0);
  });

  it('does not retry and does not count toward the failure streak', async () => {
    stubFetch(() => new Response('nope', { status: 500 }));
    const { t, endpoint } = await setup();
    const { delivery, result } = await sendTestEvent(t.env, t.org.id, endpoint.id, NOW);
    expect(result).toMatchObject({ ok: false, statusCode: 500 });
    expect(delivery).toMatchObject({ status: 'failed', attemptCount: 1 });
    expect(t.queue.sent).toHaveLength(0);
    expect(row(t, 'SELECT consecutive_failures, last_failure_at, failing_since FROM webhook_endpoints WHERE id = ?', endpoint.id)).toEqual({
      consecutive_failures: 0,
      last_failure_at: null,
      failing_since: null,
    });
  });

  it('does not turn the endpoint off on a 410', async () => {
    stubFetch(() => new Response('', { status: 410 }));
    const { t, endpoint } = await setup();
    await sendTestEvent(t.env, t.org.id, endpoint.id, NOW);
    expect(row(t, 'SELECT status FROM webhook_endpoints WHERE id = ?', endpoint.id).status).toBe('active');
  });

  it('keeps one workspace out of another', async () => {
    stubFetch();
    const { t, endpoint } = await setup();
    expect((await failure(() => sendTestEvent(t.env, 'org_other', endpoint.id, NOW))).code).toBe('not_found');
  });
});

describe('sending a delivery again', () => {
  it('starts a fresh set of tries for the same event', async () => {
    const sent = stubFetch(() => new Response('', { status: 500 }));
    const { t, deliveryId } = await setup();
    // Run it down to a final failure.
    let now = NOW;
    for (let i = 0; i < 7; i++) {
      await deliverWebhook(t.env, deliveryId, now);
      now += HOUR;
    }
    expect(deliveryRow(t, deliveryId).status).toBe('failed');
    t.queue.sent.length = 0;
    const firstId = sent[0]!.headers.get('webhook-id');

    const delivery = await resendDelivery(t.env, t.org.id, deliveryId, now);
    expect(delivery.id).toBe(deliveryId);
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'pending', attempt_count: 0, last_error: null, completed_at: null });
    const queued = t.queue.sent.shift()!;
    expect(queued.body.payload).toMatchObject({ deliveryId, expect: 0, more: false });

    const after = stubFetch();
    await runJob(t.env, queued.body);
    expect(after).toHaveLength(1);
    expect(after[0]!.headers.get('webhook-id')).toBe(firstId);
    expect(deliveryRow(t, deliveryId)).toMatchObject({ status: 'success', attempt_count: 1 });
  });

  it('is refused while the delivery is still being tried', async () => {
    stubFetch();
    const { t, deliveryId } = await setup();
    expect((await failure(() => resendDelivery(t.env, t.org.id, deliveryId, NOW))).code).toBe('webhooks.delivery_pending');
  });

  it('is refused when the endpoint is paused or off, and for another workspace', async () => {
    stubFetch();
    const { t, endpoint, deliveryId } = await setup();
    await deliverWebhook(t.env, deliveryId, NOW);
    expect((await failure(() => resendDelivery(t.env, 'org_other', deliveryId, NOW))).code).toBe('not_found');

    await updateEndpoint(t.env, t.org.id, endpoint.id, { status: 'paused' });
    expect((await failure(() => resendDelivery(t.env, t.org.id, deliveryId, NOW))).code).toBe('conflict');
    t.sqlite.prepare("UPDATE webhook_endpoints SET status = 'disabled' WHERE id = ?").run(endpoint.id);
    expect((await failure(() => resendDelivery(t.env, t.org.id, deliveryId, NOW))).code).toBe('webhooks.endpoint_disabled');
  });

  it('can be sent again after a success too', async () => {
    const sent = stubFetch();
    const { t, deliveryId } = await setup();
    await deliverWebhook(t.env, deliveryId, NOW);
    await resendDelivery(t.env, t.org.id, deliveryId, NOW + HOUR);
    await deliverWebhook(t.env, deliveryId, NOW + HOUR, 0);
    expect(sent).toHaveLength(2);
  });
});

describe('the sweeper', () => {
  it('queues a job again for a delivery whose job was lost', async () => {
    stubFetch();
    const { t, deliveryId } = await setup();
    t.sqlite.prepare('UPDATE webhook_deliveries SET next_attempt_at = ? WHERE id = ?').run(NOW, deliveryId);
    expect(await sweepDeliveries(t.env, NOW + 2 * 60_000)).toBe(0);
    expect(await sweepDeliveries(t.env, NOW + 6 * 60_000)).toBe(1);
    expect(t.queue.sent).toHaveLength(1);
    expect(await sweepDeliveries(t.env, NOW + 7 * 60_000)).toBe(0);
  });

  it('leaves finished and not-yet-due deliveries alone', async () => {
    stubFetch();
    const { t, deliveryId } = await setup();
    await deliverWebhook(t.env, deliveryId, NOW);
    expect(await sweepDeliveries(t.env, NOW + 99 * HOUR)).toBe(0);
  });
});

describe('the active cache', () => {
  it('is cleared when an endpoint is turned off', async () => {
    const { t } = await setup();
    expect(await hasActiveEndpoints(t.env, t.org.id, NOW)).toBe(true);
    t.sqlite.prepare("UPDATE webhook_endpoints SET status = 'paused'").run();
    expect(await hasActiveEndpoints(t.env, t.org.id, NOW + 1)).toBe(true);
    forgetActiveEndpoints(t.env, t.org.id);
    expect(await hasActiveEndpoints(t.env, t.org.id, NOW + 2)).toBe(false);
  });
});
