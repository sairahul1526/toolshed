import { describe, expect, it, vi } from 'vitest';
import {
  cleanupJobs,
  enqueue,
  handleQueue,
  listJobFailures,
  MAX_JOB_ATTEMPTS,
  markJobSensitive,
  once,
  recordJobFailure,
  redactPayload,
  registerCoreJob,
  retryDelaySeconds,
  retryJobFailure,
  runJob,
  runSchedules,
} from '../../src/core/jobs';
import { COUNTS_KEEP_DAYS } from '../../src/core/events';
import { createTestEnv } from '../helpers/d1';
import type { JobMessage } from '../../src/env';

const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

/** A queue message that records what the consumer did with it. */
function fakeMessage(body: JobMessage, attempts: number) {
  const out = { acked: false, retried: null as null | { delaySeconds?: number } };
  return {
    out,
    message: {
      id: 'm1',
      timestamp: new Date(),
      body,
      attempts,
      ack: () => void (out.acked = true),
      retry: (opts?: { delaySeconds?: number }) => void (out.retried = opts ?? {}),
    },
  };
}

const batch = (...messages: ReturnType<typeof fakeMessage>['message'][]) => ({ messages, queue: 'jobs', ackAll() {}, retryAll() {} }) as unknown as MessageBatch<JobMessage>;

describe('retry delays', () => {
  it('back off 30 s, 1 min, 2 min, 4 min and never pass 15 minutes', () => {
    expect([1, 2, 3, 4].map(retryDelaySeconds)).toEqual([30, 60, 120, 240]);
    expect(retryDelaySeconds(5)).toBe(480);
    expect(retryDelaySeconds(6)).toBe(900);
    expect(retryDelaySeconds(30)).toBe(900);
    expect(retryDelaySeconds(0)).toBe(30);
  });
});

describe('the queue consumer', () => {
  registerCoreJob('test-flaky', async (_env, payload) => {
    if ((payload as { fail?: boolean }).fail) throw new Error('nope');
  });

  it('acks a job that works', async () => {
    const t = createTestEnv();
    const m = fakeMessage({ name: 'core.test-flaky', payload: {} }, 1);
    await handleQueue(batch(m.message), t.env);
    expect(m.out).toEqual({ acked: true, retried: null });
  });

  it('retries a failing job with a growing delay until the last attempt', async () => {
    const spy = quiet();
    const t = createTestEnv();
    const seen: (number | undefined)[] = [];
    for (let attempt = 1; attempt < MAX_JOB_ATTEMPTS; attempt++) {
      const m = fakeMessage({ name: 'core.test-flaky', payload: { fail: true } }, attempt);
      await handleQueue(batch(m.message), t.env);
      expect(m.out.acked).toBe(false);
      seen.push(m.out.retried?.delaySeconds);
    }
    spy.mockRestore();
    expect(seen).toEqual([30, 60, 120, 240]);
    expect(await listJobFailures(t.env)).toEqual([]);
  });

  it('logs the failure and acks after the last attempt', async () => {
    const spy = quiet();
    const t = createTestEnv();
    const m = fakeMessage({ name: 'core.test-flaky', payload: { fail: true, orgId: 'org_a' } }, MAX_JOB_ATTEMPTS);
    await handleQueue(batch(m.message), t.env);
    spy.mockRestore();
    expect(m.out).toEqual({ acked: true, retried: null });
    const [failure] = await listJobFailures(t.env);
    expect(failure).toMatchObject({ name: 'core.test-flaky', orgId: 'org_a', error: 'nope', attempts: MAX_JOB_ATTEMPTS, canRetry: true, retriedAt: null });
  });

  it('handles each message on its own', async () => {
    const spy = quiet();
    const t = createTestEnv();
    const bad = fakeMessage({ name: 'core.test-flaky', payload: { fail: true } }, 1);
    const good = fakeMessage({ name: 'core.test-flaky', payload: {} }, 1);
    await handleQueue(batch(bad.message, good.message), t.env);
    spy.mockRestore();
    expect(bad.out.retried).toEqual({ delaySeconds: 30 });
    expect(good.out.acked).toBe(true);
  });

  it('still acks when the failure log itself breaks', async () => {
    const spy = quiet();
    const t = createTestEnv();
    t.sqlite.exec('DROP TABLE job_failures');
    const m = fakeMessage({ name: 'core.test-flaky', payload: { fail: true } }, MAX_JOB_ATTEMPTS);
    await handleQueue(batch(m.message), t.env);
    spy.mockRestore();
    expect(m.out.acked).toBe(true);
  });

  it('drops a job nobody handles without failing', async () => {
    const spy = quiet();
    const t = createTestEnv();
    await runJob(t.env, { name: 'core.does-not-exist', payload: null });
    spy.mockRestore();
  });
});

describe('the failure log', () => {
  it('hides secret-looking values in the preview', () => {
    const text = redactPayload({ to: 'ana@example.com', code: '123456', link: 'https://x.test/?t=1', orgId: 'org_a', n: 3, nested: { token: 'abc', fine: 'ok' } });
    expect(text).not.toContain('ana@example.com');
    expect(text).not.toContain('123456');
    expect(text).not.toContain('https://x.test');
    expect(text).not.toContain('abc');
    expect(text).toContain('org_a');
    expect(text).toContain('"fine":"ok"');
  });

  it('keeps a retryable payload for ordinary jobs and drops it for sensitive ones', async () => {
    const t = createTestEnv();
    markJobSensitive('core.test-secret');
    await recordJobFailure(t.env, { name: 'core.test-plain', payload: { orgId: 'org_a', thing: 1 } }, new Error('plain'), 5);
    await recordJobFailure(t.env, { name: 'core.test-secret', payload: { to: 'ana@example.com', code: '999' } }, new Error('secret'), 5);
    const rows = t.sqlite.prepare('SELECT name, payload, payload_preview FROM job_failures ORDER BY name').all() as { name: string; payload: string | null; payload_preview: string }[];
    expect(rows[0]).toMatchObject({ name: 'core.test-plain', payload: '{"orgId":"org_a","thing":1}' });
    expect(rows[1]).toEqual({ name: 'core.test-secret', payload: null, payload_preview: '[hidden]' });
    const listed = await listJobFailures(t.env);
    expect(listed.find((f) => f.name === 'core.test-secret')!.canRetry).toBe(false);
  });

  it('does not keep a payload that is too big to store', async () => {
    const t = createTestEnv();
    await recordJobFailure(t.env, { name: 'core.test-big', payload: { blob: 'x'.repeat(20_000) } }, new Error('big'), 5);
    const [f] = await listJobFailures(t.env);
    expect(f).toMatchObject({ canRetry: false, payloadSize: expect.any(Number) });
    expect(f!.payloadSize).toBeGreaterThan(20_000);
    expect(f!.payloadPreview.length).toBeLessThanOrEqual(301);
  });

  it('truncates long error text', async () => {
    const t = createTestEnv();
    await recordJobFailure(t.env, { name: 'core.x', payload: null }, new Error('e'.repeat(2_000)), 5);
    expect((await listJobFailures(t.env))[0]!.error).toHaveLength(500);
  });

  it('lists newest first with a limit and a cursor', async () => {
    const t = createTestEnv();
    const insert = t.sqlite.prepare(`INSERT INTO job_failures (id, name, payload_size, payload_preview, error, attempts, failed_at) VALUES (?, 'core.x', 1, '{}', 'e', 5, ?)`);
    for (let i = 1; i <= 5; i++) insert.run(`jf_${i}`, i * 1000);
    expect((await listJobFailures(t.env, { limit: 2 })).map((f) => f.id)).toEqual(['jf_5', 'jf_4']);
    expect((await listJobFailures(t.env, { limit: 10, before: 3000 })).map((f) => f.id)).toEqual(['jf_2', 'jf_1']);
  });

  it('retries a failed job once from the log, and says why it cannot when it has no payload', async () => {
    const t = createTestEnv();
    const ran: unknown[] = [];
    registerCoreJob('test-record', async (_env, payload) => void ran.push(payload));
    await recordJobFailure(t.env, { name: 'core.test-record', payload: { orgId: 'org_a', n: 1 } }, new Error('boom'), 5);
    const [f] = await listJobFailures(t.env);
    await retryJobFailure(t.env, f!.id);
    expect(await t.drainJobs()).toBe(1);
    expect(ran).toEqual([{ orgId: 'org_a', n: 1 }]);
    expect((await listJobFailures(t.env))[0]!.retriedAt).toBeGreaterThan(0);

    markJobSensitive('core.test-private');
    await recordJobFailure(t.env, { name: 'core.test-private', payload: { code: '1' } }, new Error('x'), 5);
    const priv = (await listJobFailures(t.env)).find((x) => x.name === 'core.test-private')!;
    await expect(retryJobFailure(t.env, priv.id)).rejects.toMatchObject({ code: 'conflict' });
    await expect(retryJobFailure(t.env, 'jf_missing')).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('once()', () => {
  it('runs the first time and skips repeats inside the window', async () => {
    const t = createTestEnv();
    const calls: string[] = [];
    expect(await once(t.env, 'k1', 60, async () => (calls.push('a'), 'first'))).toEqual({ ran: true, value: 'first' });
    expect(await once(t.env, 'k1', 60, async () => (calls.push('b'), 'second'))).toEqual({ ran: false });
    expect(await once(t.env, 'k2', 60, async () => 'other')).toEqual({ ran: true, value: 'other' });
    expect(calls).toEqual(['a']);
  });

  it('runs once even when two callers race', async () => {
    const t = createTestEnv();
    let n = 0;
    const results = await Promise.all([1, 2, 3, 4].map(() => once(t.env, 'race', 60, async () => ++n)));
    expect(results.filter((r) => r.ran)).toHaveLength(1);
    expect(n).toBe(1);
  });

  it('releases the key when the work throws, so a retry can run it', async () => {
    const t = createTestEnv();
    await expect(once(t.env, 'k', 60, async () => { throw new Error('first try'); })).rejects.toThrow('first try');
    expect(await once(t.env, 'k', 60, async () => 'second try')).toEqual({ ran: true, value: 'second try' });
  });

  it('runs again after the window has passed', async () => {
    const t = createTestEnv();
    await once(t.env, 'k', 60, async () => 1);
    t.sqlite.prepare('UPDATE once_keys SET expires_at = ? WHERE key = ?').run(Date.now() - 1, 'k');
    expect(await once(t.env, 'k', 60, async () => 2)).toEqual({ ran: true, value: 2 });
  });
});

describe('housekeeping', () => {
  it('cleanupJobs removes expired once keys and failures older than 30 days', async () => {
    const t = createTestEnv();
    const now = Date.now();
    t.sqlite.prepare(`INSERT INTO once_keys (key, expires_at) VALUES ('old', ?), ('live', ?)`).run(now - 1, now + 60_000);
    const insert = t.sqlite.prepare(`INSERT INTO job_failures (id, name, payload_size, payload_preview, error, attempts, failed_at) VALUES (?, 'core.x', 1, '{}', 'e', 5, ?)`);
    insert.run('jf_old', now - 31 * 86_400_000);
    insert.run('jf_new', now - 29 * 86_400_000);
    await cleanupJobs(t.env, now);
    expect((t.sqlite.prepare('SELECT key FROM once_keys').all() as { key: string }[]).map((r) => r.key)).toEqual(['live']);
    expect((await listJobFailures(t.env)).map((f) => f.id)).toEqual(['jf_new']);
  });

  it('the daily schedule also trims old event counts and rate limits', async () => {
    const t = createTestEnv();
    const at = new Date(Date.UTC(2026, 10, 22, 0, 0));
    const day = (offset: number) => new Date(at.getTime() - offset * 86_400_000).toISOString().slice(0, 10);
    t.sqlite.prepare(`INSERT INTO event_counts (org_id, module, name, day, count) VALUES ('o', 'm', 'n', ?, 1), ('o', 'm', 'n', ?, 1)`).run(day(COUNTS_KEEP_DAYS + 5), day(10));
    t.sqlite.prepare(`INSERT INTO once_keys (key, expires_at) VALUES ('stale', 1)`).run();
    const out = await runSchedules(t.env, at);
    expect(out.ran).toContain('core.housekeeping');
    expect(out.failed).toEqual([]);
    expect((t.sqlite.prepare('SELECT day FROM event_counts').all() as { day: string }[]).map((r) => r.day)).toEqual([day(10)]);
    expect(t.sqlite.prepare('SELECT COUNT(*) AS n FROM once_keys').get()).toEqual({ n: 0 });
  });

  it('is not run in the middle of the day', async () => {
    const t = createTestEnv();
    const out = await runSchedules(t.env, new Date(Date.UTC(2026, 10, 22, 13, 30)));
    expect(out.ran).not.toContain('core.housekeeping');
  });
});

describe('enqueue', () => {
  it('sends the message with an optional delay', async () => {
    const t = createTestEnv();
    await enqueue(t.env, 'core.test-flaky', { a: 1 });
    await enqueue(t.env, 'core.test-flaky', { a: 2 }, { delaySeconds: 45 });
    expect(t.queue.sent).toEqual([
      { body: { name: 'core.test-flaky', payload: { a: 1 } } },
      { body: { name: 'core.test-flaky', payload: { a: 2 } }, delaySeconds: 45 },
    ]);
  });
});
