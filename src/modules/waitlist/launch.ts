/**
 * Letting people in and writing to them: invite waves and broadcasts. Both work in small batches on
 * the queue, can be resumed, and hold a short lease so two runs never send the same email twice.
 */
import { newId, orgDb, parseJson, type OrgDb } from '../../core/db';
import { enqueue } from '../../core/jobs';
import { parse } from '../../core/errors';
import type { Env } from '../../env';
import { z } from 'zod';
import { canSendEmail, customEmail, deliver } from './emails';
import { wlErrors } from './errors';
import { fire } from './events';
import { keyedHash } from './platform';
import { newReferralCode } from './rules';
import { countSegment, parseSegment, segmentWhere, topInLine } from './segments';
import { positionOf } from './queue';
import type { Broadcast, Segment, Signup, Wave, Waitlist } from './types';

/** Emails per queue message. A free-plan Worker run gets about 50 outside calls, and each email takes a few. */
export const SEND_BATCH = 10;
/** People marked as invited per queue message. */
const MARK_BATCH = 40;
const LEASE_MS = 120_000;

const subject = z.string().trim().min(1, 'Add a subject.').max(150);
const body = z.string().trim().min(1, 'Write a message.').max(10_000);

async function loadWaitlist(env: Env, orgId: string, id: string): Promise<Waitlist | null> {
  return env.DB.prepare('SELECT * FROM wl_waitlists WHERE id = ?1 AND org_id = ?2').bind(id, orgId).first<Waitlist>();
}

/** Mark a run as ours for a couple of minutes. False when another run holds it. */
async function claim(db: OrgDb, table: 'wl_waves' | 'wl_broadcasts', id: string, now: number): Promise<boolean> {
  const res = await db.run(`UPDATE ${table} SET lease_until = ? WHERE org_id = :org AND id = ? AND status = 'sending' AND (lease_until IS NULL OR lease_until < ?)`, now + LEASE_MS, id, now);
  return res.changes === 1;
}

const release = (db: OrgDb, table: 'wl_waves' | 'wl_broadcasts', id: string) => db.run(`UPDATE ${table} SET lease_until = NULL WHERE org_id = :org AND id = ?`, id);

// ---- Invite waves ----

const waveSchema = z.object({
  name: z.string().trim().min(1, 'Name the wave.').max(80),
  size: z.coerce.number().int().min(1, 'Invite at least one person.').max(5000),
  subject,
  body,
  scheduled_at: z.coerce.number().int().positive().nullable().optional(),
});

export async function createWave(db: OrgDb, wl: Waitlist, input: unknown, segment: Segment, base: string, now = Date.now()): Promise<Wave> {
  const data = parse(waveSchema, input);
  const scheduled = data.scheduled_at && data.scheduled_at > now ? data.scheduled_at : null;
  return db.insert<Wave>('wl_waves', {
    id: newId('wlv', now),
    waitlist_id: wl.id,
    name: data.name,
    segment: JSON.stringify({ ...segment, status: undefined }),
    size: data.size,
    subject: data.subject,
    body: data.body,
    status: scheduled ? 'scheduled' : 'draft',
    scheduled_at: scheduled,
    base,
    created_at: now,
  });
}

/** Who a wave would invite right now, for the preview before the owner starts it. */
export async function wavePreview(db: OrgDb, wl: Waitlist, size: number, segment: Segment): Promise<{ matching: number; inviting: number }> {
  const matching = await countSegment(db, wl.id, { ...segment, status: 'active' });
  return { matching, inviting: Math.min(size, matching) };
}

export async function startWave(env: Env, db: OrgDb, wave: Wave, now = Date.now()): Promise<Wave> {
  if (wave.status !== 'draft' && wave.status !== 'scheduled') throw wlErrors.wrong_state('This wave has already started.');
  const next = await db.update<Wave>('wl_waves', wave.id, { status: 'sending', started_at: now, scheduled_at: null });
  await enqueue(env, 'waitlist.wave', { orgId: wave.org_id, waveId: wave.id });
  return next ?? wave;
}

export async function cancelWave(db: OrgDb, wave: Wave): Promise<void> {
  if (wave.status === 'done' || wave.status === 'cancelled') throw wlErrors.wrong_state('This wave is already finished.');
  await db.update('wl_waves', wave.id, { status: 'cancelled', finished_at: Date.now() });
}

/** Mark the next few people as invited, each with their own code. */
async function markNext(env: Env, db: OrgDb, wl: Waitlist, wave: Wave, now: number): Promise<{ marked: number; left: number }> {
  const have = await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND wave_id = ?', wave.id);
  const remaining = wave.size - (have?.n ?? 0);
  if (remaining <= 0) return { marked: 0, left: 0 };
  const people = await topInLine(db, wl.id, parseSegment(parseJson(wave.segment, {})), Math.min(remaining, MARK_BATCH));
  if (!people.length) return { marked: 0, left: 0 };
  const update = env.DB.prepare(`UPDATE wl_signups SET status = 'invited', invited_at = ?1, wave_id = ?2, invite_code = ?3 WHERE org_id = ?4 AND id = ?5 AND status = 'active'`);
  await env.DB.batch(people.map((p) => update.bind(now, wave.id, newReferralCode(12), wl.org_id, p.id)));
  return { marked: people.length, left: remaining - people.length };
}

async function emailInvites(env: Env, db: OrgDb, wl: Waitlist, wave: Wave, now: number): Promise<{ handled: number; capped: boolean }> {
  const people = await db.all<Signup>(
    `SELECT * FROM wl_signups WHERE org_id = :org AND wave_id = ? AND status = 'invited' AND invite_email_at IS NULL ORDER BY id ASC LIMIT ?`,
    wave.id,
    SEND_BATCH,
  );
  let sent = 0;
  let handled = 0;
  for (const p of people) {
    const content = { subject: wave.subject, body: wave.body, inviteCode: p.invite_code };
    const status = p.unsubscribed_at || p.is_test ? 'suppressed' : await deliver(env, wl.org_id, p.email, await customEmail(env, wave.base, wl, p, content, await positionOf(db, wl, p)), 'invite');
    if (status === 'capped') return { handled, capped: true };
    await db.run('UPDATE wl_signups SET invite_email_at = ? WHERE org_id = :org AND id = ?', now, p.id);
    handled++;
    if (status === 'sent' || status === 'dev') sent++;
    await fire(env, wl, 'signup.invited', p, { waveId: wave.id, inviteCode: p.invite_code, emailStatus: status });
  }
  if (sent) await db.run('UPDATE wl_waves SET sent = sent + ? WHERE org_id = :org AND id = ?', sent, wave.id);
  return { handled, capped: false };
}

/** One step of a wave. Marks people, emails some of them, and queues the next step until nothing is left. */
export async function waveStep(env: Env, orgId: string, waveId: string, now = Date.now()): Promise<void> {
  const db = orgDb(env.DB, orgId);
  if (!(await claim(db, 'wl_waves', waveId, now))) return;
  const wave = await db.get<Wave>('wl_waves', waveId);
  const wl = wave ? await loadWaitlist(env, orgId, wave.waitlist_id) : null;
  if (!wave || !wl) return;
  try {
    const marked = await markNext(env, db, wl, wave, now);
    const mailed = await emailInvites(env, db, wl, wave, now);
    const left = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND wave_id = ? AND status = 'invited' AND invite_email_at IS NULL`, wave.id);
    const more = marked.left > 0;
    if (mailed.capped) {
      await release(db, 'wl_waves', wave.id);
      await enqueue(env, 'waitlist.wave', { orgId, waveId }, { delaySeconds: 900 });
      return;
    }
    if ((left?.n ?? 0) > 0 || more) {
      await release(db, 'wl_waves', wave.id);
      await enqueue(env, 'waitlist.wave', { orgId, waveId }, { delaySeconds: 1 });
      return;
    }
    await db.run(`UPDATE wl_waves SET status = 'done', finished_at = ?, lease_until = NULL WHERE org_id = :org AND id = ? AND status = 'sending'`, now, wave.id);
  } catch (err) {
    await release(db, 'wl_waves', wave.id);
    throw err;
  }
}

// ---- Broadcasts ----

const broadcastSchema = z.object({ subject, body });

export async function createBroadcast(db: OrgDb, wl: Waitlist, input: unknown, segment: Segment, base: string, now = Date.now()): Promise<Broadcast> {
  const data = parse(broadcastSchema, input);
  const row = await db.insert<Broadcast>('wl_broadcasts', {
    id: newId('wlb', now),
    waitlist_id: wl.id,
    subject: data.subject,
    body: data.body,
    segment: JSON.stringify(segment),
    status: 'draft',
    base,
    created_at: now,
  });
  return { ...row, total: await broadcastAudience(db, wl, segment) };
}

/** Marketing mail goes only to people who are in, confirmed enough to be on the list, and have not opted out. */
function recipients(wl: Waitlist, seg: Segment) {
  const where = segmentWhere(wl.id, seg, false);
  return { sql: `${where.sql} AND status IN ('active', 'invited', 'accepted') AND unsubscribed_at IS NULL`, params: where.params };
}

export async function broadcastAudience(db: OrgDb, wl: Waitlist, seg: Segment): Promise<number> {
  const where = recipients(wl, seg);
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org ${where.sql}`, ...where.params);
  return row?.n ?? 0;
}

const contentHash = (env: Env, b: Pick<Broadcast, 'subject' | 'body'>) => keyedHash(env, 'wl-broadcast', `${b.subject}\n${b.body}`);

/** Send the message to one address (the owner's own) so they can see it before everyone does. */
export async function sendTest(env: Env, db: OrgDb, wl: Waitlist, bc: Broadcast, to: string): Promise<Broadcast> {
  if (!(await canSendEmail(env))) throw wlErrors.email_off();
  const sample = { id: 'sample', org_id: wl.org_id, waitlist_id: wl.id, email: to, name: 'Sample person', code: 'SAMPLE1', token: 'sample', seq: 1, score: 1 } as Signup;
  const status = await deliver(env, wl.org_id, to, await customEmail(env, bc.base, wl, sample, { subject: `[Test] ${bc.subject}`, body: bc.body }, 1), 'broadcast-test');
  if (status !== 'sent' && status !== 'dev') throw wlErrors.email_off('The test email could not be sent. Check the email settings.');
  return (await db.update<Broadcast>('wl_broadcasts', bc.id, { test_hash: await contentHash(env, bc) })) ?? bc;
}

export async function startBroadcast(env: Env, db: OrgDb, wl: Waitlist, bc: Broadcast, now = Date.now()): Promise<Broadcast> {
  if (bc.status !== 'draft') throw wlErrors.wrong_state('This broadcast has already started.');
  if (!(await canSendEmail(env))) throw wlErrors.email_off();
  if (!bc.test_hash || bc.test_hash !== (await contentHash(env, bc))) throw wlErrors.test_first();
  const total = await broadcastAudience(db, wl, parseSegment(parseJson(bc.segment, {})));
  if (total === 0) throw wlErrors.nothing_to_send();
  const next = await db.update<Broadcast>('wl_broadcasts', bc.id, { status: 'sending', total, started_at: now });
  await enqueue(env, 'waitlist.broadcast', { orgId: bc.org_id, broadcastId: bc.id });
  return next ?? bc;
}

export async function cancelBroadcast(db: OrgDb, bc: Broadcast): Promise<void> {
  if (bc.status === 'done' || bc.status === 'cancelled') throw wlErrors.wrong_state('This broadcast is already finished.');
  await db.update('wl_broadcasts', bc.id, { status: 'cancelled', finished_at: Date.now() });
}

/** Send to the next few people after the saved cursor, then queue the next step until the list ends. */
export async function broadcastStep(env: Env, orgId: string, broadcastId: string, now = Date.now()): Promise<void> {
  const db = orgDb(env.DB, orgId);
  if (!(await claim(db, 'wl_broadcasts', broadcastId, now))) return;
  const bc = await db.get<Broadcast>('wl_broadcasts', broadcastId);
  const wl = bc ? await loadWaitlist(env, orgId, bc.waitlist_id) : null;
  if (!bc || !wl) return;
  try {
    const seg = parseSegment(parseJson(bc.segment, {}));
    const where = recipients(wl, seg);
    const page = await db.all<Signup>(`SELECT * FROM wl_signups WHERE org_id = :org ${where.sql} AND id > ? ORDER BY id ASC LIMIT ?`, ...where.params, bc.cursor, SEND_BATCH);
    let sent = 0;
    let failed = 0;
    let skipped = 0;
    let cursor = bc.cursor;
    let capped = false;
    for (const p of page) {
      const status = await deliver(env, wl.org_id, p.email, await customEmail(env, bc.base, wl, p, bc, null), 'broadcast');
      if (status === 'capped') {
        capped = true;
        break;
      }
      cursor = p.id;
      if (status === 'sent' || status === 'dev') sent++;
      else if (status === 'suppressed') skipped++;
      else failed++;
    }
    const finished = !capped && page.length < SEND_BATCH;
    await db.run(
      `UPDATE wl_broadcasts SET sent = sent + ?, failed = failed + ?, skipped = skipped + ?, cursor = ?, lease_until = NULL, status = CASE WHEN ? = 1 AND status = 'sending' THEN 'done' ELSE status END, finished_at = CASE WHEN ? = 1 AND status = 'sending' THEN ? ELSE finished_at END WHERE org_id = :org AND id = ?`,
      sent, failed, skipped, cursor, finished ? 1 : 0, finished ? 1 : 0, now, bc.id,
    );
    if (!finished) await enqueue(env, 'waitlist.broadcast', { orgId, broadcastId }, { delaySeconds: capped ? 900 : 1 });
  } catch (err) {
    await release(db, 'wl_broadcasts', bc.id);
    throw err;
  }
}

/** Pick up anything that stopped (a lost message, a restart) and start waves whose time has come. */
export async function resumeLaunches(env: Env, now = Date.now()): Promise<void> {
  const due = await env.DB.prepare(`SELECT id, org_id FROM wl_waves WHERE status = 'scheduled' AND scheduled_at <= ?1 LIMIT 20`).bind(now).all<{ id: string; org_id: string }>();
  for (const w of due.results) {
    const db = orgDb(env.DB, w.org_id);
    const wave = await db.get<Wave>('wl_waves', w.id);
    if (wave) await startWave(env, db, wave, now);
  }
  const waves = await env.DB.prepare(`SELECT id, org_id FROM wl_waves WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < ?1) LIMIT 20`).bind(now).all<{ id: string; org_id: string }>();
  for (const w of waves.results) await enqueue(env, 'waitlist.wave', { orgId: w.org_id, waveId: w.id });
  const casts = await env.DB.prepare(`SELECT id, org_id FROM wl_broadcasts WHERE status = 'sending' AND (lease_until IS NULL OR lease_until < ?1) LIMIT 20`).bind(now).all<{ id: string; org_id: string }>();
  for (const b of casts.results) await enqueue(env, 'waitlist.broadcast', { orgId: b.org_id, broadcastId: b.id });
}

export function listWaves(db: OrgDb, waitlistId: string): Promise<Wave[]> {
  return db.list<Wave>('wl_waves', { where: { waitlist_id: waitlistId }, limit: 50 });
}

export function listBroadcasts(db: OrgDb, waitlistId: string): Promise<Broadcast[]> {
  return db.list<Broadcast>('wl_broadcasts', { where: { waitlist_id: waitlistId }, limit: 50 });
}
