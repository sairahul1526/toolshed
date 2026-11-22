/**
 * Transactional email: one message to one person, triggered by your own app (receipts, password
 * resets, invites). Templates are optional; you can also send a subject and body directly.
 *
 * These are not marketing, so they ignore newsletter unsubscribes and carry no unsubscribe link.
 * They do respect addresses that bounced or complained. `Idempotency-Key` makes a retried request
 * return the first result instead of sending again.
 */
import { z } from 'zod';
import { newId } from '../../core/db';
import { resolveBrand } from '../../core/email-templates/brand';
import { isValidAddress, normaliseAddress } from '../../core/email';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { enforceRateLimit } from '../../core/ratelimit';
import { mailErrors } from './errors';
import { valuesFor } from './merge';
import { renderMail } from './render';
import { coreSender, type Sender } from './sender';
import type { Ctx } from './types';

export interface Template {
  id: string;
  org_id: string;
  key: string;
  name: string;
  subject: string;
  body: string;
  created_at: number;
  updated_at: number;
}

export const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

export const templateInput = z.object({
  key: z.string().trim().toLowerCase().regex(KEY, 'Use lowercase letters, numbers, dashes and underscores.'),
  name: z.string().trim().min(1, 'Give the template a name.').max(120),
  subject: z.string().trim().min(1, 'Add a subject.').max(200),
  body: z.string().min(1, 'Write the message.').max(100_000),
});

export const listTemplates = (ctx: Ctx) => ctx.db.all<Template>('SELECT * FROM mail_templates WHERE org_id = :org ORDER BY name');

export async function getTemplate(ctx: Ctx, keyOrId: string): Promise<Template> {
  const row = (await ctx.db.findOne<Template>('mail_templates', { key: keyOrId })) ?? (await ctx.db.get<Template>('mail_templates', keyOrId));
  if (!row) throw mailErrors.template_not_found();
  return row;
}

export async function createTemplate(ctx: Ctx, raw: unknown, now = Date.now()): Promise<Template> {
  const input = parse(templateInput, raw);
  if (await ctx.db.findOne('mail_templates', { key: input.key })) throw mailErrors.template_key_taken();
  return ctx.db.insert<Template>('mail_templates', { id: newId('mtp', now), ...input, created_at: now, updated_at: now });
}

export async function updateTemplate(ctx: Ctx, id: string, raw: unknown, now = Date.now()): Promise<Template> {
  const current = await getTemplate(ctx, id);
  const input = parse(templateInput.partial(), raw);
  if (input.key && input.key !== current.key && (await ctx.db.findOne('mail_templates', { key: input.key }))) throw mailErrors.template_key_taken();
  return (await ctx.db.update<Template>('mail_templates', current.id, { ...input, updated_at: now }))!;
}

export async function deleteTemplate(ctx: Ctx, id: string): Promise<void> {
  const current = await getTemplate(ctx, id);
  await ctx.db.remove('mail_templates', current.id);
}

export const sendInput = z
  .object({
    to: z.string().trim().min(1, 'Add a recipient.'),
    template: z.string().trim().optional(),
    subject: z.string().trim().max(200).optional(),
    body: z.string().max(100_000).optional(),
    data: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,40}$/), z.union([z.string().max(1000), z.number()])).default({}),
    reply_to: z.string().trim().max(254).optional(),
  })
  .refine((v) => v.template || (v.subject && v.body), { message: 'Send a template, or both a subject and a body.', path: ['template'] });

export interface SendOutcome {
  id: string;
  status: 'sent' | 'failed' | 'suppressed' | 'dev';
  duplicate: boolean;
  error?: string;
}

interface SentRow {
  id: string;
  status: string;
  error: string;
}

export async function sendTransactional(ctx: Ctx, raw: unknown, opts: { idempotencyKey?: string; now?: number; sender?: Sender; limitKey?: string } = {}): Promise<SendOutcome> {
  const now = opts.now ?? Date.now();
  const input = parse(sendInput, raw);
  const to = normaliseAddress(input.to);
  if (!isValidAddress(to)) throw errors.validation_failed('That email address doesn’t look right.', { to: 'Enter a full address such as sam@example.com.' });
  const key = opts.idempotencyKey?.slice(0, 120);
  if (key) {
    const hit = await ctx.db.first<SentRow>('SELECT id, status, error FROM mail_sent WHERE org_id = :org AND idempotency_key = ?', key);
    if (hit) return { id: hit.id, status: hit.status as SendOutcome['status'], duplicate: true, ...(hit.error ? { error: hit.error } : {}) };
  }
  await enforceRateLimit(ctx.env, `mail:tx:${ctx.org.id}`, { limit: 120, windowSec: 60 }, 'You are sending very fast. Slow down and try again in a minute.');

  const tpl = input.template ? await getTemplate(ctx, input.template) : null;
  const subject = input.subject ?? tpl!.subject;
  const body = input.body ?? tpl!.body;
  const brand = await resolveBrand(ctx.env, ctx.org.id);
  const values = valuesFor({ email: to, fields: input.data }, Object.fromEntries(Object.entries(input.data).map(([k, v]) => [k, String(v)])));
  const rendered = renderMail({ format: 'markdown', subject, preheader: '', body }, { brand, values, footer: { listName: '', postalAddress: '', unsubscribeUrl: '', plain: true } });

  const id = newId('mst', now);
  const blocked = await ctx.db.first<{ reason: string }>("SELECT reason FROM mail_suppressions WHERE org_id = :org AND email = ? AND list_id = '' AND reason IN ('bounced', 'complaint')", to);
  const finish = async (status: SendOutcome['status'], error = ''): Promise<SendOutcome> => {
    await ctx.db.run(
      'INSERT OR IGNORE INTO mail_sent (id, org_id, template_key, to_email, subject, status, error, idempotency_key, created_at) VALUES (?, :org, ?, ?, ?, ?, ?, ?, ?)',
      id,
      tpl?.key ?? '',
      to,
      rendered.subject,
      status,
      error,
      key ?? null,
      now,
    );
    return { id, status, duplicate: false, ...(error ? { error } : {}) };
  };
  if (blocked) return finish('suppressed', 'This address bounced or complained before.');

  const result = await (opts.sender ?? coreSender(ctx.env)).send({
    orgId: ctx.org.id,
    to,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: 'mail.transactional',
    template: `mail:tx:${id}`,
    ...(input.reply_to ? { replyTo: input.reply_to } : {}),
  });
  if (!result.ok) {
    if (result.kind === 'not_configured') throw mailErrors.needs_sender();
    if (result.kind === 'capped') throw mailErrors.capped();
    await finish(result.kind === 'suppressed' ? 'suppressed' : 'failed', result.error);
    if (result.kind === 'suppressed') throw mailErrors.suppressed();
    throw mailErrors.send_failed();
  }
  const out = await finish(result.dev ? 'dev' : 'sent');
  await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'email.sent', subject: id, data: { template: tpl?.key ?? '', to }, at: now });
  return out;
}

export const recentSent = (ctx: Ctx, limit = 20) =>
  ctx.db.all<{ id: string; template_key: string; to_email: string; subject: string; status: string; error: string; created_at: number }>(
    `SELECT id, template_key, to_email, subject, status, error, created_at FROM mail_sent WHERE org_id = :org ORDER BY created_at DESC, id DESC LIMIT ${Math.min(limit, 100)}`,
  );
