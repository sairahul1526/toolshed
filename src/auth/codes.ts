/**
 * Emailed one-time codes and the sign-in link that travels with them.
 *
 * - A code is 6 digits, works once, for 10 minutes, and stops working after 5 wrong guesses.
 * - Only keyed hashes are stored, so a copy of the database is not enough to sign in.
 * - The link carries its own long random token. Opening it (a GET) changes nothing; only the
 *   button on that page (a POST) uses it up. Mail scanners that follow links cannot burn it.
 * - After 5 wrong codes for one address inside 15 minutes, checking codes for that address
 *   pauses. Links keep working, so the real owner of the inbox is never locked out by a guesser.
 */
import { newId, randomToken } from '../core/db';
import type { Env } from '../env';
import { CODE_LENGTH, CODE_MAX_ATTEMPTS, CODE_TTL_MS, LIMITS } from './config';
import { hmac, randomDigits, safeEqual } from './crypto';

export type CodePurpose = 'sign-in' | 'claim' | 'invite' | 'email-change';
export type CodeFailure = 'wrong' | 'expired' | 'used' | 'limited';

export interface IssueInput {
  purpose: CodePurpose;
  email: string;
  /** Extra data kept with the code: where to go next, a user id or an invitation id. */
  ref?: string | null;
  /** False when nobody will receive the code (unknown address): a row is kept but can never match. */
  deliverable?: boolean;
  ip?: string | null;
  userAgent?: string | null;
  now?: number;
}

export interface IssuedCode {
  id: string;
  code: string;
  /** Token for the one-press link. */
  linkToken: string;
  expiresAt: number;
}

export interface RedeemedCode {
  ok: true;
  id: string;
  purpose: CodePurpose;
  email: string;
  ref: string | null;
}

export interface RefusedCode {
  ok: false;
  reason: CodeFailure;
  /** Wrong guesses left on this code. */
  triesLeft: number;
  /** Seconds until checks for this address resume. Set when `reason` is `limited`. */
  retryAfter: number;
}

export type CodeResult = RedeemedCode | RefusedCode;

interface CodeRow {
  id: string;
  purpose: CodePurpose;
  email: string;
  ref: string | null;
  code_hash: string;
  attempts: number;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

const codeHash = (env: Env, id: string, code: string) => hmac(env.AUTH_SECRET, `code:${id}:${code}`);
const linkHash = (env: Env, token: string) => hmac(env.AUTH_SECRET, `link:${token}`);
const refuse = (reason: CodeFailure, triesLeft = 0, retryAfter = 0): RefusedCode => ({ ok: false, reason, triesLeft, retryAfter });

export async function issueCode(env: Env, input: IssueInput): Promise<IssuedCode> {
  const now = input.now ?? Date.now();
  const id = newId('cod', now);
  const code = randomDigits(CODE_LENGTH);
  const linkToken = randomToken(32);
  const deliverable = input.deliverable !== false;
  await env.DB.prepare(
    `INSERT INTO auth_codes (id, purpose, email, ref, code_hash, link_hash, attempts, ip, user_agent, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id,
      input.purpose,
      input.email,
      input.ref ?? null,
      // An undeliverable code is stored with a hash no 6 digits can produce.
      deliverable ? await codeHash(env, id, code) : await hmac(env.AUTH_SECRET, `void:${randomToken(16)}`),
      deliverable ? await linkHash(env, linkToken) : null,
      input.ip ?? null,
      (input.userAgent ?? '').slice(0, 300) || null,
      now,
      now + CODE_TTL_MS,
    )
    .run();
  return { id, code, linkToken, expiresAt: now + CODE_TTL_MS };
}

/** Seconds until code checks for this address resume, or 0 when they are not paused. */
export async function pausedFor(env: Env, purpose: CodePurpose, email: string, now = Date.now()): Promise<number> {
  const windowMs = LIMITS.wrongPerEmail.windowSec * 1000;
  const row = await env.DB.prepare(
    `SELECT COALESCE(SUM(attempts), 0) AS wrong, MIN(created_at) AS first
       FROM auth_codes WHERE purpose = ?1 AND email = ?2 AND created_at > ?3 AND attempts > 0`,
  )
    .bind(purpose, email, now - windowMs)
    .first<{ wrong: number; first: number | null }>();
  if (!row || row.first === null || row.wrong < LIMITS.wrongPerEmail.limit) return 0;
  return Math.max(1, Math.ceil((row.first + windowMs - now) / 1000));
}

/**
 * Check a typed code against the code this browser asked for (`id` comes from its signed cookie).
 * `attempts` only ever counts wrong guesses: every check takes one before comparing, so parallel
 * guesses cannot share a try, and a correct code gives its try back as it is used up.
 */
export async function redeemCode(env: Env, input: { id: string; purpose: CodePurpose; code: string; now?: number }): Promise<CodeResult> {
  const now = input.now ?? Date.now();
  const row = await env.DB.prepare('SELECT * FROM auth_codes WHERE id = ?1 AND purpose = ?2').bind(input.id, input.purpose).first<CodeRow>();
  if (!row) return refuse('expired');
  if (row.used_at !== null) return refuse('used');
  if (row.expires_at <= now) return refuse('expired');

  const paused = await pausedFor(env, row.purpose, row.email, now);
  if (paused > 0 || row.attempts >= CODE_MAX_ATTEMPTS) return refuse('limited', 0, paused);

  const code = input.code.replace(/[\s-]/g, '');
  const left = CODE_MAX_ATTEMPTS - row.attempts;
  if (!new RegExp(`^\\d{${CODE_LENGTH}}$`).test(code)) return refuse('wrong', left);

  const taken = await env.DB.prepare('UPDATE auth_codes SET attempts = attempts + 1 WHERE id = ?1 AND attempts < ?2 AND used_at IS NULL')
    .bind(row.id, CODE_MAX_ATTEMPTS)
    .run();
  if (taken.meta.changes !== 1) return refuse('limited', 0, await pausedFor(env, row.purpose, row.email, now));

  if (!(await safeEqual(await codeHash(env, row.id, code), row.code_hash))) {
    const triesLeft = left - 1;
    return triesLeft > 0 ? refuse('wrong', triesLeft) : refuse('limited', 0, await pausedFor(env, row.purpose, row.email, now));
  }

  const used = await env.DB.prepare('UPDATE auth_codes SET used_at = ?1, attempts = attempts - 1 WHERE id = ?2 AND used_at IS NULL').bind(now, row.id).run();
  if (used.meta.changes !== 1) return refuse('used');
  return { ok: true, id: row.id, purpose: row.purpose, email: row.email, ref: row.ref };
}

export interface LinkInfo {
  state: 'ok' | 'expired' | 'used' | 'invalid';
  purpose?: CodePurpose;
  email?: string;
  ip?: string | null;
  userAgent?: string | null;
  createdAt?: number;
  expiresAt?: number;
}

/** Look at a link without using it. Safe to call from a GET. */
export async function inspectLink(env: Env, token: string, now = Date.now()): Promise<LinkInfo> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return { state: 'invalid' };
  const row = await env.DB.prepare('SELECT * FROM auth_codes WHERE link_hash = ?1')
    .bind(await linkHash(env, token))
    .first<CodeRow>();
  if (!row) return { state: 'invalid' };
  const state = row.used_at !== null ? 'used' : row.expires_at <= now ? 'expired' : 'ok';
  return { state, purpose: row.purpose, email: row.email, ip: row.ip, userAgent: row.user_agent, createdAt: row.created_at, expiresAt: row.expires_at };
}

/** Use a link up. One statement finds it, checks it and marks it, so it can only ever work once. */
export async function redeemLink(env: Env, token: string, purpose: CodePurpose, now = Date.now()): Promise<CodeResult> {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return refuse('expired');
  const hash = await linkHash(env, token);
  const row = await env.DB.prepare(
    'UPDATE auth_codes SET used_at = ?1 WHERE link_hash = ?2 AND purpose = ?3 AND used_at IS NULL AND expires_at > ?1 RETURNING id, purpose, email, ref',
  )
    .bind(now, hash, purpose)
    .first<{ id: string; purpose: CodePurpose; email: string; ref: string | null }>();
  if (row) return { ok: true, ...row };
  const info = await inspectLink(env, token, now);
  return refuse(info.state === 'used' ? 'used' : 'expired');
}

/** Delete codes that ended more than a day ago. */
export async function purgeOldCodes(env: Env, now = Date.now()): Promise<void> {
  await env.DB.prepare('DELETE FROM auth_codes WHERE expires_at < ?1')
    .bind(now - 24 * 60 * 60 * 1000)
    .run();
}
