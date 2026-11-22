/** The review queue and everything an owner does to people: approve, reject, remove, tag, erase. */
import { orgDb, type OrgDb } from '../../core/db';
import { enqueue } from '../../core/jobs';
import type { Env } from '../../env';
import { canSendEmail } from './emails';
import { fire } from './events';
import { activate, creditReferral, reverseCredit } from './signups';
import type { Signup, Waitlist } from './types';

export type BulkAction = 'approve' | 'reject' | 'remove' | 'tag' | 'untag' | 'unsubscribe';

/** Rows handled per call. Each person can cost several database calls, and a request gets about 50. */
export const BULK_CHUNK = 8;
const IN_CHUNK = 90;

export function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadMany(db: OrgDb, wl: Waitlist, ids: string[]): Promise<Signup[]> {
  const rows: Signup[] = [];
  for (const part of chunks(ids, IN_CHUNK)) {
    const marks = part.map(() => '?').join(', ');
    rows.push(...(await db.all<Signup>(`SELECT * FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND id IN (${marks})`, wl.id, ...part)));
  }
  return rows;
}

const CLEAR_FLAG = 'flag_reason = NULL, flag_detail = NULL, flagged_at = NULL';

/** Let a held person (or a held referral) through. */
export async function approveOne(env: Env, db: OrgDb, wl: Waitlist, s: Signup, base: string, now: number): Promise<boolean> {
  if (s.status === 'flagged') {
    await db.run(`UPDATE wl_signups SET ${CLEAR_FLAG} WHERE org_id = :org AND id = ?`, s.id);
    const needsConfirm = s.email_verified === 0 && wl.double_optin === 1 && (await canSendEmail(env));
    if (needsConfirm) await db.run(`UPDATE wl_signups SET status = 'pending' WHERE org_id = :org AND id = ? AND status = 'flagged'`, s.id);
    else await activate(env, db, wl, { ...s, flag_reason: null }, base, s.email_verified === 1, now);
    return true;
  }
  if (s.referral_status === 'held') {
    await db.run(`UPDATE wl_signups SET ${CLEAR_FLAG} WHERE org_id = :org AND id = ?`, s.id);
    if (s.status === 'active' || s.status === 'invited' || s.status === 'accepted') await creditReferral(env, db, wl, s, base, now);
    return true;
  }
  return false;
}

/** Turn a held person away: they are removed, and their referral does not count. */
export async function rejectOne(env: Env, db: OrgDb, wl: Waitlist, s: Signup, now: number): Promise<boolean> {
  if (s.status === 'flagged') {
    await db.run(
      `UPDATE wl_signups SET status = 'removed', referral_status = CASE WHEN referral_status IN ('pending', 'held') THEN 'rejected' ELSE referral_status END WHERE org_id = :org AND id = ? AND status = 'flagged'`,
      s.id,
    );
    await fire(env, wl, 'signup.removed', s, { reason: 'rejected', at: now });
    return true;
  }
  if (s.referral_status === 'held') {
    await db.run(`UPDATE wl_signups SET referral_status = 'rejected', ${CLEAR_FLAG} WHERE org_id = :org AND id = ?`, s.id);
    return true;
  }
  return false;
}

export async function removeOne(env: Env, db: OrgDb, wl: Waitlist, s: Signup, now: number): Promise<boolean> {
  if (s.status === 'removed') return false;
  await db.run(`UPDATE wl_signups SET status = 'removed' WHERE org_id = :org AND id = ?`, s.id);
  await reverseCredit(db, wl, s);
  await fire(env, wl, 'signup.removed', s, { reason: 'removed', at: now });
  return true;
}

function nextTags(current: string, tag: string, add: boolean): string {
  const set = new Set(current.split(',').filter(Boolean));
  if (add) set.add(tag);
  else set.delete(tag);
  return set.size ? `,${[...set].sort().join(',')},` : '';
}

export function cleanTag(input: unknown): string {
  return String(input ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

async function applyOne(env: Env, db: OrgDb, wl: Waitlist, s: Signup, action: BulkAction, tag: string, base: string, now: number): Promise<boolean> {
  switch (action) {
    case 'approve':
      return approveOne(env, db, wl, s, base, now);
    case 'reject':
      return rejectOne(env, db, wl, s, now);
    case 'remove':
      return removeOne(env, db, wl, s, now);
    case 'tag':
    case 'untag': {
      if (!tag) return false;
      await db.run('UPDATE wl_signups SET tags = ? WHERE org_id = :org AND id = ?', nextTags(s.tags, tag, action === 'tag'), s.id);
      return true;
    }
    case 'unsubscribe':
      await db.run('UPDATE wl_signups SET unsubscribed_at = ? WHERE org_id = :org AND id = ? AND unsubscribed_at IS NULL', now, s.id);
      return true;
  }
}

export interface BulkJob {
  orgId: string;
  waitlistId: string;
  action: BulkAction;
  ids: string[];
  tag: string;
  base: string;
}

/** Run one chunk of a bulk action. Returns how many people it changed. */
export async function runBulk(env: Env, job: BulkJob, now = Date.now()): Promise<number> {
  const db = orgDb(env.DB, job.orgId);
  const wl = await env.DB.prepare('SELECT * FROM wl_waitlists WHERE id = ?1 AND org_id = ?2').bind(job.waitlistId, job.orgId).first<Waitlist>();
  if (!wl) return 0;
  let changed = 0;
  for (const s of await loadMany(db, wl, job.ids)) {
    if (await applyOne(env, db, wl, s, job.action, job.tag, job.base, now)) changed++;
  }
  return changed;
}

/**
 * Apply an action to many people. A few run now; more go to the queue in small chunks so no single
 * request runs out of database calls. Returns how many were handled now and how many were queued.
 */
export async function bulk(env: Env, wl: Waitlist, action: BulkAction, ids: string[], opts: { tag?: string; base: string }): Promise<{ done: number; queued: number }> {
  const unique = [...new Set(ids)].slice(0, 5000);
  const tag = cleanTag(opts.tag);
  const base = { orgId: wl.org_id, waitlistId: wl.id, action, tag, base: opts.base };
  const parts = chunks(unique, BULK_CHUNK);
  const first = parts.shift() ?? [];
  const done = first.length ? await runBulk(env, { ...base, ids: first }) : 0;
  for (const ids of parts) await enqueue(env, 'waitlist.bulk', { ...base, ids });
  return { done, queued: parts.reduce((n, p) => n + p.length, 0) };
}

/** Everyone waiting for a decision: held signups and signups whose referral is held. */
export function reviewQueue(db: OrgDb, waitlistId: string, limit = 200): Promise<Signup[]> {
  return db.all<Signup>(
    `SELECT * FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND (status = 'flagged' OR (referral_status = 'held' AND status != 'removed')) ORDER BY flagged_at ASC, seq ASC LIMIT ?`,
    waitlistId,
    limit,
  );
}

export async function reviewCount(db: OrgDb, waitlistId: string): Promise<number> {
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 0 AND (status = 'flagged' OR (referral_status = 'held' AND status != 'removed'))`,
    waitlistId,
  );
  return row?.n ?? 0;
}

/**
 * Delete one person's data. The row goes, the waitlist keeps an anonymous count, and the people they
 * referred lose the link to them. The referrer's credit stays: the referral did happen.
 */
export async function erase(env: Env, wl: Waitlist, s: Signup, now = Date.now()): Promise<void> {
  const db = orgDb(env.DB, wl.org_id);
  await fire(env, wl, 'signup.removed', s, { reason: 'erased', at: now, email: null, name: null });
  await db.run('DELETE FROM wl_reached WHERE org_id = :org AND signup_id = ?', s.id);
  await db.run('UPDATE wl_signups SET referred_by = NULL WHERE org_id = :org AND referred_by = ?', s.id);
  await db.run('DELETE FROM wl_signups WHERE org_id = :org AND id = ?', s.id);
  if (s.is_test === 0) await db.run('UPDATE wl_waitlists SET anon_count = anon_count + 1, updated_at = ? WHERE org_id = :org AND id = ?', now, wl.id);
}

/** Erase by address, for a person who writes in. Returns whether anyone was found. */
export async function eraseByEmail(env: Env, wl: Waitlist, email: string): Promise<boolean> {
  const db = orgDb(env.DB, wl.org_id);
  const s = await db.first<Signup>('SELECT * FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND email = ?', wl.id, email.trim().toLowerCase());
  if (!s) return false;
  await erase(env, wl, s);
  return true;
}

/** Delete every test signup on a waitlist in one go. */
export async function clearTestSignups(db: OrgDb, waitlistId: string): Promise<number> {
  await db.run('DELETE FROM wl_reached WHERE org_id = :org AND waitlist_id = ? AND signup_id IN (SELECT id FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 1)', waitlistId, waitlistId);
  const res = await db.run('DELETE FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND is_test = 1', waitlistId);
  return res.changes;
}
