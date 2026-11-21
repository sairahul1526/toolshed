/**
 * Sending email. Every attempt is written to `email_log`.
 *
 * - With the EMAIL binding (Cloudflare Email Sending) and a sender address, the message is sent for real.
 * - In dev there is no binding: the message is stored with its body and shown at /dev/outbox, which
 *   is how the end-to-end tests read sign-in codes.
 * - In production without the binding the status is `not_configured` and the Email screen says so.
 *
 * Production never stores a body, a code or a link in the log, only who, what kind and what happened.
 * A send that fails for a temporary reason is retried through the job queue with a growing delay; the
 * message waits in the queue, not in the database. Addresses that hard-bounce are suppressed.
 */
import { z } from 'zod';
import type { Env } from '../env';
import { isDev } from '../env';
import { audit, decodeCursor, encodeCursor, likeEscape } from './audit';
import { newId } from './db';
import { renderEmail } from './email-templates';
import { enforceRateLimit, rateLimit } from './ratelimit';
import { errors, parse } from './errors';
import { MAX_JOB_ATTEMPTS, markJobSensitive, registerCoreJob, registerCoreSchedule, enqueue, retryDelaySeconds } from './jobs';
import { getSetting, INSTANCE, setSetting } from './settings';

export interface EmailMessage {
  orgId?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Template name, for the delivery log (for example `sign-in-code`). */
  template?: string;
  tag?: string;
  replyTo?: string;
}

export type EmailStatus = 'sent' | 'dev' | 'not_configured' | 'failed' | 'retrying' | 'suppressed' | 'capped';

export const EMAIL_STATUSES: readonly EmailStatus[] = ['sent', 'dev', 'not_configured', 'failed', 'retrying', 'suppressed', 'capped'];

export interface EmailResult {
  id: string;
  status: EmailStatus;
  /** A plain sentence saying what went wrong. Never holds a code or a link. */
  error?: string;
  /** The id Cloudflare gave the message, when it was sent. */
  messageId?: string;
}

// ---------------------------------------------------------------------------------------------
// Sender settings and status
// ---------------------------------------------------------------------------------------------

export interface SenderSettings {
  fromAddress: string;
  fromName: string;
  replyTo?: string;
}

const SENDER_KEY = 'email.sender';

export async function getSender(env: Env): Promise<SenderSettings> {
  const saved = await getSetting<Partial<SenderSettings>>(env, INSTANCE, SENDER_KEY, {});
  return {
    fromAddress: typeof saved.fromAddress === 'string' ? saved.fromAddress : '',
    fromName: typeof saved.fromName === 'string' && saved.fromName.trim() ? saved.fromName : 'Toolshed',
    ...(typeof saved.replyTo === 'string' && saved.replyTo ? { replyTo: saved.replyTo } : {}),
  };
}

const senderSchema = z.object({
  fromName: z
    .string()
    .trim()
    .min(1, 'Enter the name people will see.')
    .max(60, 'Keep the name under 60 characters.')
    .refine((v) => !/[\r\n<>"]/.test(v), 'Use letters, numbers and simple punctuation only.'),
  fromAddress: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a full address, like hello@example.com.').max(254)]),
  replyTo: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a full address, like help@example.com.').max(254)]).optional(),
});

/** Save the sender (owner only: the caller checks). An empty address turns real sending off. */
export async function setSender(
  env: Env,
  input: unknown,
  actor?: { id?: string | null; email?: string | null },
): Promise<SenderSettings> {
  const parsed = parse(senderSchema, input);
  const sender: SenderSettings = {
    fromName: parsed.fromName,
    fromAddress: parsed.fromAddress,
    ...(parsed.replyTo ? { replyTo: parsed.replyTo } : {}),
  };
  await setSetting(env, INSTANCE, SENDER_KEY, sender);
  await audit(env, {
    orgId: null,
    actorId: actor?.id ?? null,
    actorLabel: actor?.email ?? null,
    action: 'email.sender_changed',
    summary: sender.fromAddress ? `Set the sender to ${sender.fromName} <${sender.fromAddress}>` : 'Cleared the sender address',
  });
  return sender;
}

export type EmailMode = 'live' | 'dev' | 'off';

export interface EmailSetup {
  status: 'ready' | 'needs_setup';
  /** Plain sentence: what is wrong, or what dev mode does. */
  reason?: string;
  /** What to do next. */
  action?: { label: string; href: string };
  /** `live` sends for real, `dev` saves to the outbox, `off` cannot send. */
  mode: EmailMode;
}

export async function emailStatus(env: Env): Promise<EmailSetup> {
  const sender = await getSender(env);
  if (env.EMAIL && sender.fromAddress) return { status: 'ready', mode: 'live' };
  if (isDev(env)) {
    return { status: 'ready', mode: 'dev', reason: 'Dev mode: emails are saved to the outbox instead of being sent.' };
  }
  if (!env.EMAIL) {
    return {
      status: 'needs_setup',
      mode: 'off',
      reason: 'Email sending isn’t turned on for this install, so sign-in codes and invites can’t be delivered.',
      action: { label: 'See how to turn it on', href: '/app/email' },
    };
  }
  return {
    status: 'needs_setup',
    mode: 'off',
    reason: 'Choose the address emails are sent from. It must be on a domain you added to Cloudflare Email Sending.',
    action: { label: 'Choose a sender', href: '/app/email' },
  };
}

export async function emailReady(env: Env): Promise<boolean> {
  return (await emailStatus(env)).mode === 'live';
}

// ---------------------------------------------------------------------------------------------
// Talking to Cloudflare
// ---------------------------------------------------------------------------------------------

/** What we hand to the binding. A subset of Cloudflare's own message builder. */
export interface BindingMessage {
  from: { email: string; name: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
  headers?: Record<string, string>;
}

type Binding = { send(message: BindingMessage): Promise<{ messageId?: string } | void> };

/** The only place that calls the binding. Tests pass a fake with the same `send`. */
export async function sendViaBinding(
  binding: Binding,
  message: BindingMessage,
): Promise<{ messageId?: string }> {
  const res = await binding.send(message);
  return { ...(res && typeof res.messageId === 'string' ? { messageId: res.messageId } : {}) };
}

type FailureKind = 'bounce' | 'permanent' | 'transient';

interface Failure {
  kind: FailureKind;
  /** Cloudflare's error code, when there is one. */
  code: string | null;
  /** A plain sentence for the log. */
  message: string;
}

const PERMANENT_REASON: Record<string, string> = {
  E_VALIDATION_ERROR: 'Cloudflare rejected the message as invalid.',
  E_RECIPIENT_NOT_ALLOWED: 'Cloudflare doesn’t allow sending to this address yet. Check your Email Sending plan.',
  E_RECIPIENT_PLAN_RESTRICTED: 'Your Cloudflare plan only allows sending to verified addresses.',
  E_CONTENT_TOO_LARGE: 'The message was too large to send.',
};

/** Turn whatever the binding threw into a decision and a plain sentence. Exported for tests. */
export function classifyFailure(err: unknown): Failure {
  const code = typeof (err as { code?: unknown } | null)?.code === 'string' ? (err as { code: string }).code : null;
  const raw = err instanceof Error ? err.message : String(err);
  const detail = raw.replace(/\s+/g, ' ').slice(0, 200);
  const tag = code ? ` (${code})` : '';

  if (err instanceof TypeError) return { kind: 'permanent', code, message: `The message was malformed and couldn’t be sent${tag}.` };
  if (code === 'E_RECIPIENT_SUPPRESSED') {
    return { kind: 'bounce', code, message: `Cloudflare has this address on its suppression list${tag}.` };
  }
  if (code === 'E_DELIVERY_FAILED' && /\b5\d\d\b/.test(raw)) {
    return { kind: 'bounce', code, message: `The recipient’s mail server rejected the address${tag}.` };
  }
  if (code && code.startsWith('E_SENDER_')) {
    return { kind: 'permanent', code, message: `The sender address isn’t set up in Cloudflare Email Sending. Check the sender on the Email screen${tag}.` };
  }
  if (code && PERMANENT_REASON[code]) return { kind: 'permanent', code, message: `${PERMANENT_REASON[code]}${tag}` };
  if (code === 'E_RATE_LIMIT_EXCEEDED' || code === 'E_DAILY_LIMIT_EXCEEDED') {
    return { kind: 'transient', code, message: `Cloudflare’s sending limit was reached. We will try again${tag}.` };
  }
  return { kind: 'transient', code, message: `Cloudflare couldn’t send it right now${tag}. ${detail}`.trim() };
}

// ---------------------------------------------------------------------------------------------
// Suppression: addresses that bounced for good are not tried again
// ---------------------------------------------------------------------------------------------

export function normaliseAddress(address: string): string {
  return address.trim().toLowerCase();
}

const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

export function isValidAddress(address: string): boolean {
  return address.length <= 254 && ADDRESS.test(address);
}

export async function isSuppressed(env: Env, address: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS x FROM email_suppressions WHERE address = ?1').bind(normaliseAddress(address)).first();
  return row !== null;
}

export async function suppressAddress(env: Env, address: string, reason: string, orgId?: string | null): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO email_suppressions (address, org_id, reason, created_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT (address) DO NOTHING`,
  )
    .bind(normaliseAddress(address), orgId ?? '', reason.slice(0, 200), Date.now())
    .run();
}

/** Let an address receive email again (for example after the person fixed their mailbox). */
export async function unsuppressAddress(env: Env, address: string, actor?: { id?: string | null; email?: string | null; orgId?: string | null }): Promise<boolean> {
  const res = await env.DB.prepare('DELETE FROM email_suppressions WHERE address = ?1').bind(normaliseAddress(address)).run();
  const removed = (res.meta.changes ?? 0) > 0;
  if (removed) {
    await audit(env, {
      orgId: actor?.orgId ?? null,
      actorId: actor?.id ?? null,
      actorLabel: actor?.email ?? null,
      action: 'email.suppression_removed',
      summary: `Allowed email to ${normaliseAddress(address)} again`,
    });
  }
  return removed;
}

export async function listSuppressions(env: Env, limit = 100): Promise<{ address: string; reason: string; at: number }[]> {
  const { results } = await env.DB.prepare(
    `SELECT address, reason, created_at FROM email_suppressions ORDER BY created_at DESC, address LIMIT ${Math.min(Math.max(1, limit), 500)}`,
  ).all<{ address: string; reason: string; created_at: number }>();
  return results.map((r) => ({ address: r.address, reason: r.reason, at: r.created_at }));
}

// ---------------------------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------------------------

export interface EmailCaps {
  /** Emails to one address per hour. */
  perRecipientPerHour: number;
  /** Emails from the whole install per hour. */
  perInstallPerHour: number;
}

const DEFAULT_CAPS: EmailCaps = { perRecipientPerHour: 10, perInstallPerHour: 300 };

export async function getEmailCaps(env: Env): Promise<EmailCaps> {
  const saved = await getSetting<Partial<EmailCaps>>(env, INSTANCE, 'email.caps', {});
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 100_000 ? v : d);
  return {
    perRecipientPerHour: num(saved.perRecipientPerHour, DEFAULT_CAPS.perRecipientPerHour),
    perInstallPerHour: num(saved.perInstallPerHour, DEFAULT_CAPS.perInstallPerHour),
  };
}

// ---------------------------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------------------------

interface LogRow {
  id: string;
  msg: EmailMessage;
  status: EmailStatus;
  error?: string | null;
  attempts?: number;
  messageId?: string | null;
}

async function writeLog(env: Env, row: LogRow): Promise<void> {
  const keepBody = isDev(env);
  await env.DB.prepare(
    `INSERT INTO email_log (id, org_id, to_addr, subject, template, tag, status, error, body_text, body_html, created_at, attempts, message_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
  )
    .bind(
      row.id,
      row.msg.orgId ?? null,
      row.msg.to,
      row.msg.subject,
      row.msg.template ?? null,
      row.msg.tag ?? null,
      row.status,
      row.error ?? null,
      keepBody ? row.msg.text : null,
      keepBody ? row.msg.html : null,
      Date.now(),
      row.attempts ?? 1,
      row.messageId ?? null,
    )
    .run();
}

function bindingMessage(sender: SenderSettings, msg: EmailMessage): BindingMessage {
  const replyTo = msg.replyTo ?? sender.replyTo;
  return {
    from: { email: sender.fromAddress, name: sender.fromName },
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(replyTo ? { replyTo } : {}),
  };
}

/**
 * Send one email and log it. Never throws for delivery problems: read `status` on the result.
 * `sent` and `dev` are fine; `retrying` means a temporary problem and another try is queued.
 */
export async function sendEmail(env: Env, input: EmailMessage): Promise<EmailResult> {
  const id = newId('eml');
  const msg: EmailMessage = { ...input, to: normaliseAddress(input.to), subject: input.subject.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').trim() };
  const done = async (status: EmailStatus, extra: { error?: string; messageId?: string; attempts?: number } = {}): Promise<EmailResult> => {
    await writeLog(env, { id, msg, status, error: extra.error ?? null, messageId: extra.messageId ?? null, attempts: extra.attempts ?? 1 });
    return { id, status, ...(extra.error ? { error: extra.error } : {}), ...(extra.messageId ? { messageId: extra.messageId } : {}) };
  };

  if (!isValidAddress(msg.to)) return done('failed', { error: 'That isn’t a valid email address.' });
  if (await isSuppressed(env, msg.to)) {
    return done('suppressed', { error: 'This address bounced before, so we stopped sending to it.' });
  }

  const sender = await getSender(env);
  if (!(env.EMAIL && sender.fromAddress)) return done(isDev(env) ? 'dev' : 'not_configured');

  const caps = await getEmailCaps(env);
  const [one, all] = await Promise.all([
    rateLimit(env, `email:to:${msg.to}`, { limit: caps.perRecipientPerHour, windowSec: 3600 }),
    rateLimit(env, 'email:all', { limit: caps.perInstallPerHour, windowSec: 3600 }),
  ]);
  if (!one.ok) return done('capped', { error: `Too many emails to this address this hour (limit ${caps.perRecipientPerHour}).` });
  if (!all.ok) return done('capped', { error: `This install reached its hourly email limit (${caps.perInstallPerHour}).` });

  try {
    const sent = await sendViaBinding(env.EMAIL as unknown as Binding, bindingMessage(sender, msg));
    return done('sent', sent.messageId ? { messageId: sent.messageId } : {});
  } catch (err) {
    const failure = classifyFailure(err);
    if (failure.kind === 'bounce') {
      await suppressAddress(env, msg.to, failure.message, msg.orgId);
      return done('failed', { error: failure.message });
    }
    if (failure.kind === 'permanent') return done('failed', { error: failure.message });
    try {
      await enqueue(env, 'core.email-retry', { logId: id, message: msg }, { delaySeconds: retryDelaySeconds(1) });
    } catch {
      return done('failed', { error: failure.message });
    }
    return done('retrying', { error: failure.message });
  }
}

interface RetryPayload {
  logId: string;
  message: EmailMessage;
}

function isRetryPayload(p: unknown): p is RetryPayload {
  const m = (p as RetryPayload | null)?.message;
  return typeof (p as RetryPayload | null)?.logId === 'string' && !!m && typeof m.to === 'string' && typeof m.subject === 'string';
}

// The payload holds the recipient and the body, so a failure record never keeps it.
markJobSensitive('core.email-retry');

registerCoreJob('email-retry', async (env, payload, ctx) => {
  if (!isRetryPayload(payload)) return;
  const { logId, message } = payload;
  const attempts = ctx.attempt + 1;
  const update = (status: EmailStatus, error: string | null, messageId: string | null = null) =>
    env.DB.prepare('UPDATE email_log SET status = ?2, error = ?3, attempts = ?4, message_id = COALESCE(?5, message_id) WHERE id = ?1')
      .bind(logId, status, error, attempts, messageId)
      .run();

  if (await isSuppressed(env, message.to)) {
    await update('suppressed', 'This address bounced before, so we stopped sending to it.');
    return;
  }
  const sender = await getSender(env);
  if (!(env.EMAIL && sender.fromAddress)) {
    await update('failed', 'Email sending was turned off before this could be sent.');
    return;
  }
  try {
    const sent = await sendViaBinding(env.EMAIL as unknown as Binding, bindingMessage(sender, message));
    await update('sent', null, sent.messageId ?? null);
  } catch (err) {
    const failure = classifyFailure(err);
    if (failure.kind === 'bounce') await suppressAddress(env, message.to, failure.message, message.orgId);
    if (failure.kind !== 'transient') {
      await update('failed', failure.message);
      return;
    }
    if (ctx.attempt >= MAX_JOB_ATTEMPTS) {
      await update('failed', `Gave up after ${attempts} tries. ${failure.message}`);
    } else {
      await update('retrying', failure.message);
    }
    throw err;
  }
});

/** Send the "test" email to `to` so an owner can check the setup. Needs email to be on. */
export async function sendTestEmail(
  env: Env,
  to: string,
  actor: { id?: string | null; email?: string | null; orgId?: string | null },
): Promise<EmailResult> {
  const address = normaliseAddress(to);
  if (!isValidAddress(address)) throw errors.validation_failed(undefined, { to: 'Enter a full address, like you@example.com.' });
  const status = await emailStatus(env);
  if (status.mode === 'off') throw errors.needs_setup(status.reason);
  await enforceRateLimit(env, `email.test:${actor.id ?? address}`, { limit: 5, windowSec: 3600 }, 'You sent a few test emails already. Try again in a while.');
  const rendered = await renderEmail(env, { template: 'test', data: {}, orgId: actor.orgId ?? null });
  const result = await sendEmail(env, { to: address, ...rendered, template: 'test', ...(actor.orgId ? { orgId: actor.orgId } : {}) });
  await audit(env, {
    orgId: actor.orgId ?? null,
    actorId: actor.id ?? null,
    actorLabel: actor.email ?? null,
    action: 'email.test_sent',
    summary: `Sent a test email to ${address}`,
    meta: { status: result.status },
  });
  return result;
}

// ---------------------------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------------------------

export interface EmailLogItem {
  id: string;
  orgId: string | null;
  to: string;
  subject: string;
  template: string | null;
  status: string;
  error: string | null;
  attempts: number;
  messageId: string | null;
  at: number;
}

export interface EmailLogPage {
  items: EmailLogItem[];
  nextCursor: string | null;
  /** How many emails had each status in the last 7 days (same workspace filter, ignores the other filters). */
  counts: Record<string, number>;
}

/** Delivery log, newest first. Leave `orgId` out to read the whole install (instance owner only). */
export async function listEmailLog(
  env: Env,
  opts: { orgId?: string | null; status?: string; q?: string; before?: string; limit?: number } = {},
): Promise<EmailLogPage> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
  const params: (string | number | null)[] = [];
  const parts: string[] = [];
  const add = (sql: string, ...values: (string | number | null)[]) => {
    let i = params.length;
    parts.push(sql.replace(/\?/g, () => `?${++i}`));
    params.push(...values);
  };
  if (opts.orgId) add('org_id = ?', opts.orgId);
  if (opts.status) add('status = ?', opts.status);
  const q = opts.q?.trim();
  if (q) {
    const like = `%${likeEscape(q.slice(0, 100))}%`;
    add(`(to_addr LIKE ? ESCAPE '\\' OR subject LIKE ? ESCAPE '\\')`, like, like);
  }
  if (opts.before) {
    const c = decodeCursor(opts.before);
    add('(created_at < ? OR (created_at = ? AND id < ?))', c.at, c.at, c.id);
  }
  const { results } = await env.DB.prepare(
    `SELECT id, org_id, to_addr, subject, template, status, error, attempts, message_id, created_at
     FROM email_log ${parts.length ? `WHERE ${parts.join(' AND ')}` : ''} ORDER BY created_at DESC, id DESC LIMIT ${limit + 1}`,
  )
    .bind(...params)
    .all<{
      id: string;
      org_id: string | null;
      to_addr: string;
      subject: string;
      template: string | null;
      status: string;
      error: string | null;
      attempts: number;
      message_id: string | null;
      created_at: number;
    }>();
  const page = results.slice(0, limit);
  const last = page[page.length - 1];

  const countRows = await env.DB.prepare(
    'SELECT status, COUNT(*) AS n FROM email_log WHERE created_at >= ?1 AND (?2 IS NULL OR org_id = ?2) GROUP BY status',
  )
    .bind(Date.now() - 7 * 86_400_000, opts.orgId ?? null)
    .all<{ status: string; n: number }>();
  const counts: Record<string, number> = Object.fromEntries(EMAIL_STATUSES.map((s) => [s, 0]));
  for (const r of countRows.results) counts[r.status] = r.n;

  return {
    items: page.map((r) => ({
      id: r.id,
      orgId: r.org_id,
      to: r.to_addr,
      subject: r.subject,
      template: r.template,
      status: r.status,
      error: r.error,
      attempts: r.attempts,
      messageId: r.message_id,
      at: r.created_at,
    })),
    nextCursor: results.length > limit && last ? encodeCursor(last) : null,
    counts,
  };
}

export interface OutboxEmail {
  id: string;
  to: string;
  subject: string;
  template: string | null;
  status: string;
  text: string | null;
  html: string | null;
  createdAt: number;
}

/** Latest emails with bodies. Dev only; used by /dev/outbox and the end-to-end tests. */
export async function devOutbox(env: Env, opts: { to?: string; limit?: number } = {}): Promise<OutboxEmail[]> {
  const limit = Math.min(opts.limit ?? 20, 100);
  const { results } = await env.DB.prepare(
    `SELECT id, to_addr, subject, template, status, body_text, body_html, created_at
     FROM email_log WHERE (?1 IS NULL OR to_addr = ?1) ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
  )
    .bind(opts.to ?? null)
    .all<{
      id: string;
      to_addr: string;
      subject: string;
      template: string | null;
      status: string;
      body_text: string | null;
      body_html: string | null;
      created_at: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    to: r.to_addr,
    subject: r.subject,
    template: r.template,
    status: r.status,
    text: r.body_text,
    html: r.body_html,
    createdAt: r.created_at,
  }));
}

// ---------------------------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------------------------

export const EMAIL_LOG_DAYS = 30;

/** Delete log rows older than the retention (setting `email.logRetentionDays`, default 30 days). */
export async function purgeEmailLog(env: Env, now = Date.now()): Promise<number> {
  const saved = await getSetting<unknown>(env, INSTANCE, 'email.logRetentionDays', EMAIL_LOG_DAYS);
  const days = typeof saved === 'number' && Number.isInteger(saved) && saved >= 1 && saved <= 3650 ? saved : EMAIL_LOG_DAYS;
  const cutoff = now - days * 86_400_000;
  let deleted = 0;
  for (let i = 0; i < 10; i++) {
    const res = await env.DB.prepare('DELETE FROM email_log WHERE id IN (SELECT id FROM email_log WHERE created_at < ?1 LIMIT 500)')
      .bind(cutoff)
      .run();
    const n = res.meta.changes ?? 0;
    deleted += n;
    if (n < 500) break;
  }
  return deleted;
}

registerCoreSchedule({ name: 'email-log-retention', every: 'day', run: async (env, at) => void (await purgeEmailLog(env, at.getTime())) });
