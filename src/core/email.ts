/**
 * Sending email. Every attempt is written to `email_log`.
 * - With the EMAIL binding (Cloudflare Email Sending) the message is sent for real.
 * - In dev there is no binding: the message is stored with its body and shown at /dev/outbox,
 *   which is how the end-to-end tests read sign-in codes.
 * - In production without the binding the status is `not_configured` and the Email screen says so.
 */
import type { Env } from '../env';
import { isDev } from '../env';
import { newId } from './db';
import { getSetting, INSTANCE } from './settings';

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

export type EmailStatus = 'sent' | 'dev' | 'not_configured' | 'failed';

export interface EmailResult {
  id: string;
  status: EmailStatus;
  error?: string;
}

export interface SenderSettings {
  fromAddress: string;
  fromName: string;
}

export function getSender(env: Env): Promise<SenderSettings> {
  return getSetting<SenderSettings>(env, INSTANCE, 'email.sender', { fromAddress: '', fromName: 'Toolshed' });
}

export async function emailReady(env: Env): Promise<boolean> {
  if (!env.EMAIL) return false;
  return (await getSender(env)).fromAddress !== '';
}

export async function sendEmail(env: Env, msg: EmailMessage): Promise<EmailResult> {
  const id = newId('eml');
  let status: EmailStatus;
  let error: string | undefined;

  const sender = await getSender(env);
  if (env.EMAIL && sender.fromAddress) {
    try {
      await deliver(env, sender, msg);
      status = 'sent';
    } catch (err) {
      status = 'failed';
      error = err instanceof Error ? err.message : String(err);
    }
  } else if (isDev(env)) {
    status = 'dev';
  } else {
    status = 'not_configured';
  }

  const keepBody = isDev(env);
  await env.DB.prepare(
    `INSERT INTO email_log (id, org_id, to_addr, subject, template, tag, status, error, body_text, body_html, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  )
    .bind(
      id,
      msg.orgId ?? null,
      msg.to,
      msg.subject,
      msg.template ?? null,
      msg.tag ?? null,
      status,
      error ?? null,
      keepBody ? msg.text : null,
      keepBody ? msg.html : null,
      Date.now(),
    )
    .run();

  return { id, status, ...(error ? { error } : {}) };
}

/** Hand the message to Cloudflare Email Sending. Kept separate so tests can replace the binding. */
async function deliver(env: Env, sender: SenderSettings, msg: EmailMessage): Promise<void> {
  const binding = env.EMAIL as unknown as {
    send(message: {
      from: string | { email: string; name?: string };
      to: string;
      subject: string;
      html?: string;
      text?: string;
      replyTo?: string;
    }): Promise<unknown>;
  };
  await binding.send({
    from: { email: sender.fromAddress, name: sender.fromName },
    to: msg.to,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
  });
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
