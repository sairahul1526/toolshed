import { describe, expect, it } from 'vitest';
import { createBroadcast, getBroadcast } from './broadcasts';
import { CAP_BACKOFF_MS, LOCK_MS, CLAIM_LEASE_MS, pauseBroadcast, resumeBroadcast, runBatch, scheduleBroadcast, startBroadcast, watchdog } from './engine';
import { recordBounce } from './suppression';
import { unsubscribe } from './subscribers';
import { addPeople, DAY, fixture, HOUR, MIN, T0 } from './testkit';

const draft = (f: Awaited<ReturnType<typeof fixture>>, extra: Record<string, unknown> = {}) =>
  createBroadcast(f.ctx, { list_id: f.list.id, subject: 'Issue 1', body: 'Hello {{first_name|friend}}.\n\nSee [the post](https://example.com/post).', ...extra }, T0);

const payload = (f: Awaited<ReturnType<typeof fixture>>, id: string) => ({ orgId: f.t.org.id, broadcastId: id });

async function drain(f: Awaited<ReturnType<typeof fixture>>, id: string, from: number, step = 3_000, max = 40) {
  let now = from;
  for (let i = 0; i < max; i++) {
    const r = await runBatch(f.t.env, payload(f, id), now, { sender: f.sender });
    now += step;
    if (r.state === 'done') return now;
  }
  throw new Error('never finished');
}

describe('send engine', () => {
  it('sends to every active subscriber once, in batches, then finishes', async () => {
    const f = await fixture();
    await addPeople(f, 12);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    await drain(f, b.id, T0);
    const done = await getBroadcast(f.ctx, b.id);
    expect(done.status).toBe('sent');
    expect(done.sent_count).toBe(12);
    expect(new Set(f.sender.to()).size).toBe(12);
    expect(f.sender.sent).toHaveLength(12);
    const first = f.sender.sent[0]!;
    expect(first.headers?.['List-Unsubscribe']).toMatch(/^<http:\/\/localhost\/n\/u\//);
    expect(first.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(first.text).toContain('1 Example Street');
    expect(first.text).toContain('Unsubscribe:');
  });

  it('resumes after a crash in the middle of a batch and never sends twice', async () => {
    const f = await fixture();
    await addPeople(f, 12);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    f.sender.crashAfter = 3;
    await expect(runBatch(f.t.env, payload(f, b.id), T0 + 1_000, { sender: f.sender })).rejects.toThrow('process killed');
    // The first batch died after three messages left. The lock and the claims are still held.
    expect((await runBatch(f.t.env, payload(f, b.id), T0 + 2_000, { sender: f.sender })).state).toBe('skipped');
    // Past the lock and the claim lease, the same job picks the work up again.
    const later = T0 + Math.max(LOCK_MS, CLAIM_LEASE_MS) + 5_000;
    await drain(f, b.id, later);
    const done = await getBroadcast(f.ctx, b.id);
    expect(done.status).toBe('sent');
    const to = f.sender.to();
    expect(to).toHaveLength(12);
    expect(new Set(to).size).toBe(12);
  });

  it('does not repeat a message that left but was never written down', async () => {
    const f = await fixture();
    await addPeople(f, 3);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    // Simulate: all three left, then the process died before the database was updated.
    const ran = await runBatch(f.t.env, payload(f, b.id), T0 + 1_000, { sender: f.sender });
    expect(ran.sent).toBe(3);
    f.t.sqlite.exec("UPDATE mail_deliveries SET status = 'sending', sent_at = NULL, claimed_at = 1");
    f.t.sqlite.exec('UPDATE mail_broadcasts SET lock_until = NULL, next_run_at = NULL');
    await drain(f, b.id, T0 + HOUR);
    expect(f.sender.sent).toHaveLength(3);
    expect((await getBroadcast(f.ctx, b.id)).sent_count).toBe(3);
  });

  it('skips people who unsubscribed or were suppressed after the send started', async () => {
    const f = await fixture();
    const emails = await addPeople(f, 6);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    const sub = (e: string) => f.t.sqlite.prepare('SELECT id FROM mail_subscribers WHERE email = ?').get(e) as { id: string };
    await unsubscribe(f.ctx, { s: sub(emails[0]!).id, l: f.list.id }, 'unsubscribed', T0 + 1_000);
    await recordBounce(f.ctx, emails[1]!, 'mailbox full', T0 + 1_000);
    await drain(f, b.id, T0 + 2_000);
    expect(f.sender.to()).not.toContain(emails[0]);
    expect(f.sender.to()).not.toContain(emails[1]);
    expect(f.sender.sent).toHaveLength(4);
    expect((await getBroadcast(f.ctx, b.id)).skipped_count).toBe(2);
  });

  it('backs off when the hourly cap is hit and carries on afterwards', async () => {
    const f = await fixture();
    await addPeople(f, 8);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    let calls = 0;
    f.sender.script = () => (++calls > 2 && calls <= 3 ? { ok: false, kind: 'capped', error: 'cap' } : undefined);
    const r = await runBatch(f.t.env, payload(f, b.id), T0 + 1_000, { sender: f.sender });
    expect(r.state).toBe('backoff');
    // Too early: nothing happens.
    expect((await runBatch(f.t.env, payload(f, b.id), T0 + 5_000, { sender: f.sender })).state).toBe('skipped');
    await drain(f, b.id, T0 + 1_000 + CAP_BACKOFF_MS + 1_000);
    expect(new Set(f.sender.to()).size).toBe(8);
    expect((await getBroadcast(f.ctx, b.id)).status).toBe('sent');
  });

  it('pauses when email is not set up, and resume starts it again', async () => {
    const f = await fixture();
    await addPeople(f, 2);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    f.sender.script = () => ({ ok: false, kind: 'not_configured', error: 'no sender' });
    expect((await runBatch(f.t.env, payload(f, b.id), T0 + 1_000, { sender: f.sender })).state).toBe('paused');
    expect((await getBroadcast(f.ctx, b.id)).status).toBe('paused');
    f.sender.script = () => undefined;
    await resumeBroadcast(f.ctx, b.id, T0 + 2_000);
    await drain(f, b.id, T0 + 3_000);
    expect(f.sender.sent).toHaveLength(2);
  });

  it('manual pause stops batches; the watchdog restarts a stalled send', async () => {
    const f = await fixture();
    await addPeople(f, 3);
    const b = await draft(f);
    await startBroadcast(f.ctx, b.id, T0);
    await pauseBroadcast(f.ctx, b.id, T0 + 500);
    expect((await runBatch(f.t.env, payload(f, b.id), T0 + 1_000, { sender: f.sender })).state).toBe('skipped');
    await resumeBroadcast(f.ctx, b.id, T0 + 2_000);
    f.t.queue.sent.length = 0;
    const w = await watchdog(f.t.env, T0 + 2_000 + 10 * MIN);
    expect(w.restarted).toBe(1);
    expect(f.t.queue.sent.length).toBe(1);
  });

  it('a scheduled broadcast starts only once its time has come', async () => {
    const f = await fixture();
    await addPeople(f, 2);
    const b = await draft(f);
    await scheduleBroadcast(f.ctx, b.id, T0 + DAY, T0);
    expect((await watchdog(f.t.env, T0 + HOUR)).started).toBe(0);
    expect((await getBroadcast(f.ctx, b.id)).status).toBe('scheduled');
    expect((await watchdog(f.t.env, T0 + DAY + MIN)).started).toBe(1);
    expect((await getBroadcast(f.ctx, b.id)).status).toBe('sending');
    await expect(scheduleBroadcast(f.ctx, b.id, T0 + 2 * DAY, T0)).rejects.toThrow();
  });

  it('refuses to send without a postal address, and a failed start sends nothing', async () => {
    const f = await fixture({ postal: false });
    await addPeople(f, 2);
    const b = await draft(f);
    await expect(startBroadcast(f.ctx, b.id, T0)).rejects.toThrow();
    expect(f.sender.sent).toHaveLength(0);
    expect((await getBroadcast(f.ctx, b.id)).status).toBe('draft');
  });

  it('rewrites links and adds a pixel only when tracking is switched on', async () => {
    const f = await fixture();
    await addPeople(f, 1);
    const plain = await draft(f);
    await startBroadcast(f.ctx, plain.id, T0);
    await drain(f, plain.id, T0 + 1_000);
    expect(f.sender.sent[0]!.html).toContain('https://example.com/post');
    expect(f.sender.sent[0]!.html).not.toContain('/n/c/');
    expect(f.sender.sent[0]!.html).not.toContain('/n/o/');

    const tracked = await draft(f, { subject: 'Issue 2', track_clicks: true, track_opens: true });
    await startBroadcast(f.ctx, tracked.id, T0 + DAY);
    await drain(f, tracked.id, T0 + DAY + 1_000);
    const m = f.sender.sent[1]!;
    expect(m.html).toContain('/n/c/');
    expect(m.html).toContain('/n/o/');
    expect(m.html).not.toContain('href="https://example.com/post"');
    expect(m.text).toContain('counts opens and clicks');
  });
});
