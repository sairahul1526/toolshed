/**
 * Joining, confirming, referral credit and the work that follows a signup. `join` is the hot path:
 * one lookup for the referrer, one insert. Emails, events and the slower fraud checks run in
 * `processSignup`, off the request.
 */
import { newId, orgDb, randomToken, type OrgDb } from '../../core/db';
import { errors } from '../../core/errors';
import { enqueue } from '../../core/jobs';
import type { Env } from '../../env';
import { canSendEmail, confirmEmail, deliver, milestoneEmail, statusEmail, welcomeEmail } from './emails';
import { wlErrors } from './errors';
import { fire } from './events';
import { positionOf } from './queue';
import {
  BURST_WINDOW_MS,
  canonicalEmail,
  cleanCode,
  cleanEmail,
  domainRefusal,
  FRAUD_REASONS,
  newReferralCode,
  SIGNUP_LEVEL,
  staticFlags,
  thresholds,
  VISITOR_WINDOW_MS,
  type FraudReason,
} from './rules';
import { questionsOf } from './waitlists';
import type { Signup, Tier, Waitlist } from './types';

export interface JoinInput {
  email: unknown;
  name?: unknown;
  answers?: unknown;
  ref?: unknown;
  source?: unknown;
  medium?: unknown;
  campaign?: unknown;
  test?: boolean;
  /** Added by the owner (API, import form): no holds, no confirmation email. */
  trusted?: boolean;
  verified?: boolean;
  /** Keyed hash of the visitor's address and browser. */
  visitor: string;
  base: string;
}

export type JoinResult = { kind: 'created'; signup: Signup; position: number | null; needsConfirm: boolean } | { kind: 'existing' };

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function cleanAnswers(wl: Waitlist, raw: unknown): Record<string, string> {
  const given = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: Record<string, string> = {};
  const fields: Record<string, string> = {};
  for (const q of questionsOf(wl)) {
    let value = text(given[q.id], 1000);
    if (q.type === 'checkbox') value = ['on', 'true', '1', 'yes'].includes(value.toLowerCase()) ? 'yes' : '';
    if (q.type === 'select' && !q.options.includes(value)) value = '';
    if (q.required && !value) fields[q.id] = `${q.label} is required.`;
    if (value) out[q.id] = value;
  }
  if (Object.keys(fields).length) throw errors.validation_failed(undefined, fields);
  return out;
}

interface Referrer {
  id: string;
  email_key: string;
  visitor: string;
  status: string;
}

async function findReferrer(env: Env, wl: Waitlist, ref: unknown): Promise<Referrer | null> {
  const code = cleanCode(ref);
  if (!code) return null;
  return env.DB.prepare(`SELECT id, email_key, visitor, status FROM wl_signups WHERE waitlist_id = ?1 AND code = ?2 AND status NOT IN ('removed')`)
    .bind(wl.id, code)
    .first<Referrer>();
}

type NewRow = Record<string, string | number | null>;

async function insertRow(env: Env, row: NewRow): Promise<Signup | 'duplicate'> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const cols = Object.keys(row);
    const values = Object.values(row);
    const marks = cols.map((_, i) => `?${i + 1}`);
    marks.push(`(SELECT COALESCE(MAX(seq), 0) + 1 FROM wl_signups WHERE waitlist_id = ?${cols.length + 1})`);
    try {
      const sql = `INSERT INTO wl_signups (${cols.join(', ')}, seq) VALUES (${marks.join(', ')}) RETURNING *`;
      const saved = await env.DB.prepare(sql).bind(...values, row.waitlist_id).first<Signup>();
      if (saved) return saved;
    } catch (err) {
      const msg = String((err as Error).message);
      if (!msg.includes('UNIQUE')) throw err;
      if (/wl_signups\.email\b/.test(msg)) return 'duplicate';
      if (/wl_signups\.code\b/.test(msg)) row.code = newReferralCode();
      if (/wl_signups\.token\b/.test(msg)) row.token = randomToken(18);
    }
  }
  throw errors.internal();
}

/** Add a person. Returns `existing` (and says nothing about who) when the address is already on the list. */
export async function join(env: Env, wl: Waitlist, input: JoinInput, now = Date.now()): Promise<JoinResult> {
  if (wl.status !== 'live' && !input.test) throw wlErrors.closed();
  const email = cleanEmail(input.email);
  if (!email) throw wlErrors.bad_email(undefined, { email: 'Enter a valid email address.' });
  if (domainRefusal(email.slice(email.lastIndexOf('@') + 1), wl)) throw wlErrors.email_not_allowed(undefined, { email: 'Use a different email address.' });
  const answers = cleanAnswers(wl, input.answers);
  const canonical = canonicalEmail(email);
  const referrer = await findReferrer(env, wl, input.ref);
  const flags = input.test || input.trusted ? [] : staticFlags(wl.fraud_level, wl, { email, canonical }, referrer);
  const hold = flags.find((f) => SIGNUP_LEVEL.includes(f));
  const heldReferral = flags.find((f) => !SIGNUP_LEVEL.includes(f));
  const needsConfirm = !input.test && !input.trusted && wl.double_optin === 1 && (await canSendEmail(env));
  const status = hold ? 'flagged' : needsConfirm ? 'pending' : 'active';
  const reason = hold ?? heldReferral ?? null;
  const verified = input.test || (input.trusted && input.verified) ? 1 : 0;
  const row: NewRow = {
    id: newId('wls', now),
    org_id: wl.org_id,
    waitlist_id: wl.id,
    email,
    email_key: canonical,
    name: text(input.name, 100),
    answers: JSON.stringify(answers),
    source: text(input.source, 60),
    medium: text(input.medium, 60),
    campaign: text(input.campaign, 60),
    visitor: input.visitor,
    code: newReferralCode(),
    token: randomToken(18),
    referred_by: referrer && !input.test ? referrer.id : null,
    referral_status: !referrer || input.test ? 'none' : reason ? 'held' : 'pending',
    status: input.test ? 'active' : status,
    email_verified: verified,
    confirmed_at: verified ? now : null,
    is_test: input.test ? 1 : 0,
    flag_reason: reason,
    flag_detail: reason ? FRAUD_REASONS[reason] : null,
    flagged_at: reason ? now : null,
    created_at: now,
  };
  const saved = await insertRow(env, row);
  if (saved === 'duplicate') return { kind: 'existing' };
  const db = orgDb(env.DB, wl.org_id);
  return { kind: 'created', signup: saved, position: await positionOf(db, wl, saved), needsConfirm };
}

/** Run the slow part of a signup now, or hand it to the queue when it fails. Safe to call twice. */
export async function afterJoin(env: Env, signupId: string, base: string): Promise<void> {
  try {
    await processSignup(env, signupId, base);
  } catch {
    await enqueue(env, 'waitlist.process-signup', { signupId, base }, { delaySeconds: 30 });
  }
}

async function load(env: Env, id: string): Promise<{ db: OrgDb; wl: Waitlist; s: Signup } | null> {
  const s = await env.DB.prepare('SELECT * FROM wl_signups WHERE id = ?1').bind(id).first<Signup>();
  if (!s) return null;
  const wl = await env.DB.prepare('SELECT * FROM wl_waitlists WHERE id = ?1').bind(s.waitlist_id).first<Waitlist>();
  return wl ? { db: orgDb(env.DB, s.org_id), wl, s } : null;
}

async function setFlag(db: OrgDb, s: Signup, reason: FraudReason, scope: 'signup' | 'referral', now: number): Promise<void> {
  const detail = FRAUD_REASONS[reason];
  if (scope === 'signup') {
    await db.run(
      `UPDATE wl_signups SET status = 'flagged', flag_reason = ?, flag_detail = ?, flagged_at = ?, referral_status = CASE WHEN referral_status = 'pending' THEN 'held' ELSE referral_status END WHERE org_id = :org AND id = ? AND status IN ('pending', 'active')`,
      reason, detail, now, s.id,
    );
  } else {
    await db.run(`UPDATE wl_signups SET referral_status = 'held', flag_reason = ?, flag_detail = ?, flagged_at = ? WHERE org_id = :org AND id = ? AND referral_status = 'pending'`, reason, detail, now, s.id);
  }
}

/** Checks that need the database: many signups from one visitor, a duplicate address, a burst for one referrer. */
async function deeperChecks(env: Env, db: OrgDb, wl: Waitlist, s: Signup, now: number): Promise<{ signupReason?: FraudReason; referralReason?: FraudReason }> {
  const t = thresholds(wl.fraud_level);
  const out: { signupReason?: FraudReason; referralReason?: FraudReason } = {};
  if (s.is_test === 1) return out;
  if (t.visitorCap > 0 && s.visitor) {
    const n = await db.first<{ n: number }>(
      'SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND visitor = ? AND id != ? AND is_test = 0 AND created_at >= ?',
      wl.id, s.visitor, s.id, now - VISITOR_WINDOW_MS,
    );
    if ((n?.n ?? 0) >= t.visitorCap) out.signupReason = 'many_from_visitor';
  }
  if (!out.signupReason && t.duplicate) {
    const dup = await db.first<{ id: string }>('SELECT id FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND email_key = ? AND id != ? AND status != ? LIMIT 1', wl.id, s.email_key, s.id, 'removed');
    if (dup) out.signupReason = 'duplicate_address';
  }
  if (s.referred_by && s.referral_status === 'pending') {
    const ref = await db.first<{ visitor: string }>('SELECT visitor FROM wl_signups WHERE org_id = :org AND id = ?', s.referred_by);
    if (t.sameVisitor && ref && ref.visitor && ref.visitor === s.visitor) out.referralReason = 'same_visitor';
    else if (t.burst > 0) {
      const n = await db.first<{ n: number }>(
        'SELECT COUNT(*) AS n FROM wl_signups WHERE org_id = :org AND waitlist_id = ? AND referred_by = ? AND id != ? AND created_at >= ?',
        wl.id, s.referred_by, s.id, now - BURST_WINDOW_MS,
      );
      if ((n?.n ?? 0) >= t.burst) out.referralReason = 'referrer_burst';
    }
  }
  return out;
}

export async function processSignup(env: Env, signupId: string, base: string, now = Date.now()): Promise<void> {
  const ctx = await load(env, signupId);
  if (!ctx) return;
  const { db, wl } = ctx;
  let s = ctx.s;
  const claimed = await db.run('UPDATE wl_signups SET processed_at = ? WHERE org_id = :org AND id = ? AND processed_at IS NULL', now, s.id);
  if (claimed.changes === 0) return;
  try {
    const found = await deeperChecks(env, db, wl, s, now);
    if (found.signupReason) await setFlag(db, s, found.signupReason, 'signup', now);
    else if (found.referralReason) await setFlag(db, s, found.referralReason, 'referral', now);
    s = (await db.get<Signup>('wl_signups', s.id)) ?? s;
    await fire(env, wl, 'signup.created', s);
    if (s.referred_by) await fire(env, wl, 'signup.referred', s, { referrerId: s.referred_by });
    if (s.flag_reason) await fire(env, wl, 'signup.flagged', s, { reason: s.flag_reason, scope: s.status === 'flagged' ? 'signup' : 'referral' });
    if (s.is_test === 1) return;
    if (s.status === 'pending' || (s.status === 'flagged' && s.email_verified === 0 && wl.double_optin === 1)) {
      const sent = await deliver(env, wl.org_id, s.email, await confirmEmail(env, base, wl, s), 'confirm');
      if (sent === 'not_configured' && s.status === 'pending') await activate(env, db, wl, s, base, false, now);
    } else if (s.status === 'active') {
      await onActive(env, db, wl, s, base, now);
    }
  } catch (err) {
    await db.run('UPDATE wl_signups SET processed_at = NULL WHERE org_id = :org AND id = ?', s.id);
    throw err;
  }
}

/** A person has become active without confirming (email is off): mark unverified and do what activation does. */
export async function activate(env: Env, db: OrgDb, wl: Waitlist, s: Signup, base: string, verified: boolean, now: number): Promise<void> {
  await db.run(
    `UPDATE wl_signups SET status = 'active', email_verified = ?, confirmed_at = ? WHERE org_id = :org AND id = ? AND status IN ('pending', 'flagged')`,
    verified ? 1 : 0, verified ? now : null, s.id,
  );
  const fresh = (await db.get<Signup>('wl_signups', s.id)) ?? s;
  await onActive(env, db, wl, fresh, base, now);
}

async function onActive(env: Env, db: OrgDb, wl: Waitlist, s: Signup, base: string, now: number): Promise<void> {
  if (s.referral_status === 'pending') await creditReferral(env, db, wl, s, base, now);
  if (s.status !== 'active' || s.unsubscribed_at) return;
  const position = await positionOf(db, wl, s);
  await deliver(env, wl.org_id, s.email, await welcomeEmail(env, base, wl, s, position), 'welcome');
}

/** Count a referral for the referrer, once, and tell them when it unlocks a reward tier. */
export async function creditReferral(env: Env, db: OrgDb, wl: Waitlist, s: Signup, base: string, now = Date.now()): Promise<void> {
  if (!s.referred_by) return;
  const claimed = await db.run(`UPDATE wl_signups SET referral_status = 'credited' WHERE org_id = :org AND id = ? AND referral_status IN ('pending', 'held')`, s.id);
  if (claimed.changes === 0) return;
  const referrer = await db.first<Signup>(
    'UPDATE wl_signups SET referral_count = referral_count + 1, adj = adj - ? WHERE org_id = :org AND id = ? RETURNING *',
    wl.skip_per_referral, s.referred_by,
  );
  if (!referrer) return;
  const tiers = await db.all<Tier>('SELECT * FROM wl_tiers WHERE org_id = :org AND waitlist_id = ? AND referrals_required <= ?', wl.id, referrer.referral_count);
  for (const tier of tiers) {
    const fresh = await db.run('INSERT OR IGNORE INTO wl_reached (org_id, waitlist_id, signup_id, tier_id, reached_at) VALUES (:org, ?, ?, ?, ?)', wl.id, referrer.id, tier.id, now);
    if (fresh.changes === 0) continue;
    await fire(env, wl, 'signup.milestone', referrer, { tierId: tier.id, tier: tier.name, referrals: referrer.referral_count });
    if (referrer.status !== 'removed' && !referrer.unsubscribed_at && referrer.is_test === 0) {
      await deliver(env, wl.org_id, referrer.email, await milestoneEmail(env, base, wl, referrer, tier), 'milestone');
    }
  }
}

async function reverseCredit(db: OrgDb, wl: Waitlist, s: Signup): Promise<void> {
  if (s.referral_status !== 'credited' || !s.referred_by) return;
  await db.run(
    'UPDATE wl_signups SET referral_count = MAX(0, referral_count - 1), adj = adj + ? WHERE org_id = :org AND id = ? AND referral_count > 0',
    wl.skip_per_referral, s.referred_by,
  );
}

/** The confirm link was followed (and the Continue button pressed). Idempotent. */
export async function confirm(env: Env, wl: Waitlist, s: Signup, base: string, now = Date.now()): Promise<Signup> {
  if (s.email_verified === 1) return s;
  const db = orgDb(env.DB, wl.org_id);
  if (s.status === 'pending') await activate(env, db, wl, s, base, true, now);
  else await db.run('UPDATE wl_signups SET email_verified = 1, confirmed_at = ? WHERE org_id = :org AND id = ?', now, s.id);
  const fresh = (await db.get<Signup>('wl_signups', s.id)) ?? s;
  await fire(env, wl, 'signup.confirmed', fresh);
  return fresh;
}

/** Email the person their status link (or the confirm link when still pending). Says nothing about whether they exist. */
export async function sendStatusLink(env: Env, wl: Waitlist, email: unknown, base: string): Promise<void> {
  const clean = cleanEmail(email);
  if (!clean) return;
  const s = await env.DB.prepare(`SELECT * FROM wl_signups WHERE waitlist_id = ?1 AND email = ?2 AND status != 'removed'`).bind(wl.id, clean).first<Signup>();
  if (!s || s.is_test === 1) return;
  const built = s.email_verified === 0 && s.status === 'pending' ? await confirmEmail(env, base, wl, s) : await statusEmail(env, base, wl, s);
  await deliver(env, wl.org_id, s.email, built, s.status === 'pending' ? 'confirm' : 'status');
}

export async function findByToken(env: Env, token: string): Promise<{ wl: Waitlist; s: Signup } | null> {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return null;
  const s = await env.DB.prepare(`SELECT * FROM wl_signups WHERE token = ?1 AND status != 'removed'`).bind(token).first<Signup>();
  if (!s) return null;
  const wl = await env.DB.prepare('SELECT * FROM wl_waitlists WHERE id = ?1').bind(s.waitlist_id).first<Waitlist>();
  return wl ? { wl, s } : null;
}

export async function findBySlug(env: Env, slug: string): Promise<Waitlist | null> {
  return env.DB.prepare('SELECT * FROM wl_waitlists WHERE slug = ?1').bind(slug.toLowerCase()).first<Waitlist>();
}

export interface PersonView {
  status: 'pending' | 'active' | 'review' | 'invited' | 'accepted';
  position: number | null;
  referralCode: string;
  referrals: number;
  verified: boolean;
  tiers: { name: string; need: number; reward: string; reached: boolean }[];
  next: { name: string; remaining: number } | null;
}

/** What a person may see about themselves: their place, their link, their progress. */
export async function personView(env: Env, wl: Waitlist, s: Signup): Promise<PersonView> {
  const db = orgDb(env.DB, wl.org_id);
  const [tiers, position] = await Promise.all([db.all<Tier>('SELECT * FROM wl_tiers WHERE org_id = :org AND waitlist_id = ? ORDER BY referrals_required ASC', wl.id), positionOf(db, wl, s)]);
  const view = tiers.map((t) => ({ name: t.name, need: t.referrals_required, reward: t.reward_text, reached: s.referral_count >= t.referrals_required }));
  const next = view.find((t) => !t.reached);
  return {
    status: s.status === 'flagged' ? 'review' : (s.status as PersonView['status']),
    position,
    referralCode: s.code,
    referrals: s.referral_count,
    verified: s.email_verified === 1,
    tiers: view,
    next: next ? { name: next.name, remaining: next.need - s.referral_count } : null,
  };
}

export async function trackAcceptance(env: Env, wl: Waitlist, code: string, now = Date.now()): Promise<Signup | null> {
  const clean = code.trim().slice(0, 64);
  if (!clean) return null;
  const s = await env.DB.prepare('SELECT * FROM wl_signups WHERE waitlist_id = ?1 AND invite_code = ?2').bind(wl.id, clean).first<Signup>();
  if (!s || s.status === 'removed') return null;
  if (s.status === 'invited') {
    const db = orgDb(env.DB, wl.org_id);
    await db.run(`UPDATE wl_signups SET status = 'accepted', accepted_at = ? WHERE org_id = :org AND id = ? AND status = 'invited'`, now, s.id);
    await db.run('UPDATE wl_waves SET accepted = accepted + 1 WHERE org_id = :org AND id = ?', s.wave_id);
    const fresh = (await db.get<Signup>('wl_signups', s.id)) ?? s;
    await fire(env, wl, 'signup.accepted', fresh);
    return fresh;
  }
  return s;
}

export { reverseCredit };
