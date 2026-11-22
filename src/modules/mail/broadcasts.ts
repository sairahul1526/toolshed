/**
 * Broadcasts: one email to a newsletter's active subscribers. This file is the editor side (create,
 * edit, preview, test send, schedule). `engine.ts` does the sending.
 *
 * A broadcast is editable until it starts sending. Sending always goes through `engine.startBroadcast`,
 * which runs the pre-send checklist first.
 */
import { z } from 'zod';
import { newId } from '../../core/db';
import { resolveBrand } from '../../core/email-templates/brand';
import { emailStatus } from '../../core/email';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { composeMessage } from './emails';
import { mailErrors } from './errors';
import { getList } from './lists';
import { findTags, SYSTEM_TAGS } from './merge';
import { linksIn } from './render';
import { filterSchema, EMPTY_FILTER, parseFilter, compileFilter, type Filter } from './segments';
import { coreSender, type Sender } from './sender';
import { getMailSettings } from './settings';
import { listFields } from './lists';
import type { Broadcast, Ctx, List } from './types';

export const HOURLY_CAP = 300;

export const broadcastInput = z.object({
  list_id: z.string().min(1),
  subject: z.string().trim().max(200).default(''),
  preheader: z.string().trim().max(200).default(''),
  format: z.enum(['markdown', 'html']).default('markdown'),
  body: z.string().max(200_000).default(''),
  filter: filterSchema.optional(),
  track_opens: z.boolean().optional(),
  track_clicks: z.boolean().optional(),
  in_archive: z.boolean().optional(),
});
export type BroadcastInput = z.infer<typeof broadcastInput>;

const EDITABLE = ['draft', 'scheduled'] as const;

export async function getBroadcast(ctx: Ctx, id: string): Promise<Broadcast> {
  const row = await ctx.db.get<Broadcast>('mail_broadcasts', id);
  if (!row) throw mailErrors.broadcast_not_found();
  return row;
}

export const filterOf = (b: Pick<Broadcast, 'filter'>): Filter => parseFilter(b.filter);

export async function listBroadcasts(ctx: Ctx, opts: { listId?: string; status?: string; limit?: number; offset?: number } = {}): Promise<{ items: Broadcast[]; total: number }> {
  const where = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.listId) (where.push('list_id = ?'), params.push(opts.listId));
  if (opts.status) (where.push('status = ?'), params.push(opts.status));
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const [items, count] = await Promise.all([
    ctx.db.all<Broadcast>(`SELECT * FROM mail_broadcasts WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ${limit} OFFSET ${Math.max(opts.offset ?? 0, 0)}`, ...params),
    ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM mail_broadcasts WHERE ${where.join(' AND ')}`, ...params),
  ]);
  return { items, total: count?.n ?? 0 };
}

export async function createBroadcast(ctx: Ctx, raw: unknown, now = Date.now()): Promise<Broadcast> {
  const input = parse(broadcastInput, raw);
  await getList(ctx, input.list_id);
  const settings = await getMailSettings(ctx.env, ctx.org.id);
  return ctx.db.insert<Broadcast>('mail_broadcasts', {
    id: newId('mbc', now),
    list_id: input.list_id,
    subject: input.subject,
    preheader: input.preheader,
    format: input.format,
    body: input.body,
    filter: JSON.stringify(input.filter ?? EMPTY_FILTER),
    status: 'draft',
    track_opens: (input.track_opens ?? settings.trackOpens) ? 1 : 0,
    track_clicks: (input.track_clicks ?? settings.trackClicks) ? 1 : 0,
    in_archive: input.in_archive ? 1 : 0,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
}

export async function updateBroadcast(ctx: Ctx, id: string, raw: unknown, now = Date.now()): Promise<Broadcast> {
  const current = await getBroadcast(ctx, id);
  if (!(EDITABLE as readonly string[]).includes(current.status)) throw mailErrors.not_editable();
  const input = parse(broadcastInput.partial(), raw);
  const patch: Record<string, string | number | null> = { updated_at: now };
  if (input.list_id !== undefined) {
    await getList(ctx, input.list_id);
    patch.list_id = input.list_id;
  }
  for (const k of ['subject', 'preheader', 'format', 'body'] as const) if (input[k] !== undefined) patch[k] = input[k] as string;
  if (input.filter !== undefined) patch.filter = JSON.stringify(input.filter);
  for (const k of ['track_opens', 'track_clicks', 'in_archive'] as const) if (input[k] !== undefined) patch[k] = input[k] ? 1 : 0;
  return (await ctx.db.update<Broadcast>('mail_broadcasts', id, patch))!;
}

export async function duplicateBroadcast(ctx: Ctx, id: string, now = Date.now()): Promise<Broadcast> {
  const b = await getBroadcast(ctx, id);
  return ctx.db.insert<Broadcast>('mail_broadcasts', {
    id: newId('mbc', now),
    list_id: b.list_id,
    subject: b.subject,
    preheader: b.preheader,
    format: b.format,
    body: b.body,
    filter: b.filter,
    status: 'draft',
    track_opens: b.track_opens,
    track_clicks: b.track_clicks,
    in_archive: b.in_archive,
    source: 'manual',
    created_at: now,
    updated_at: now,
  });
}

export async function deleteBroadcast(ctx: Ctx, id: string): Promise<void> {
  const b = await getBroadcast(ctx, id);
  if (b.status === 'sending') throw mailErrors.not_editable();
  const d1 = ctx.db.d1;
  await d1.batch([
    d1.prepare('DELETE FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id = ?2').bind(ctx.org.id, id),
    d1.prepare('DELETE FROM mail_links WHERE org_id = ?1 AND broadcast_id = ?2').bind(ctx.org.id, id),
    d1.prepare('DELETE FROM mail_broadcasts WHERE org_id = ?1 AND id = ?2').bind(ctx.org.id, id),
  ]);
}

// -- audience ---------------------------------------------------------------------------------------

/** The SQL for "active members of this newsletter who match the filter and are not suppressed". Aliased `s` and `m`. */
export function audienceSql(listId: string, filter: Filter, now: number): { sql: string; params: (string | number)[] } {
  const f = compileFilter(filter, now);
  return {
    sql: `FROM mail_subscribers s
      JOIN mail_memberships m ON m.org_id = s.org_id AND m.subscriber_id = s.id AND m.list_id = ? AND m.status = 'active'
      WHERE s.org_id = :org
        AND NOT EXISTS (SELECT 1 FROM mail_suppressions x WHERE x.org_id = s.org_id AND x.email = s.email AND x.list_id IN ('', ?))
        AND ${f.sql}`,
    params: [listId, listId, ...f.params],
  };
}

export async function audienceCount(ctx: Ctx, listId: string, filter: Filter, now = Date.now()): Promise<number> {
  const a = audienceSql(listId, filter, now);
  return (await ctx.db.first<{ n: number }>(`SELECT COUNT(*) AS n ${a.sql}`, ...a.params))?.n ?? 0;
}

// -- preview and test send ------------------------------------------------------------------------

export async function previewBroadcast(
  ctx: Ctx,
  id: string,
  opts: { subscriberId?: string; base: string },
): Promise<{ subject: string; html: string; text: string; who: string }> {
  const b = await getBroadcast(ctx, id);
  const list = await getList(ctx, b.list_id);
  const sub = opts.subscriberId
    ? await ctx.db.get<{ id: string; email: string; name: string; fields: string }>('mail_subscribers', opts.subscriberId)
    : null;
  const person = sub ?? { id: 'preview', email: 'sam@example.com', name: 'Sam Rivera', fields: '{}' };
  const [brand, settings] = await Promise.all([resolveBrand(ctx.env, ctx.org.id), getMailSettings(ctx.env, ctx.org.id)]);
  const m = await composeMessage({ env: ctx.env, list, sub: person, content: b, kind: 'mail.broadcast', scope: b.id, base: opts.base, brand, postalAddress: settings.postalAddress, preview: !sub });
  return { subject: m.subject, html: m.html, text: m.text, who: person.email };
}

/** Send one copy to an address the person typed. Never touches subscribers, deliveries or counters. */
export async function sendTest(ctx: Ctx, id: string, toRaw: unknown, base: string, deps: { sender?: Sender; now?: number } = {}): Promise<void> {
  const to = String(toRaw ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw errors.validation_failed('That email address doesn’t look right.', { to: 'Enter a full address such as sam@example.com.' });
  const b = await getBroadcast(ctx, id);
  const list = await getList(ctx, b.list_id);
  const [brand, settings] = await Promise.all([resolveBrand(ctx.env, ctx.org.id), getMailSettings(ctx.env, ctx.org.id)]);
  const m = await composeMessage({ env: ctx.env, list, sub: { id: 'test', email: to, name: 'Sam Rivera', fields: '{}' }, content: b, kind: 'mail.test', scope: `test:${b.id}`, base, brand, postalAddress: settings.postalAddress, preview: true });
  // A test is allowed to repeat, so make each one unique in the log.
  const result = await (deps.sender ?? coreSender(ctx.env)).send({ ...m, template: `mail:test:${b.id}:${deps.now ?? Date.now()}` });
  if (!result.ok) {
    if (result.kind === 'not_configured') throw mailErrors.needs_sender();
    if (result.kind === 'capped') throw mailErrors.capped();
    if (result.kind === 'suppressed') throw mailErrors.suppressed();
    throw mailErrors.send_failed();
  }
  await ctx.db.update('mail_broadcasts', id, { last_test_at: deps.now ?? Date.now() });
}

// -- checklist ----------------------------------------------------------------------------------------

export interface CheckItem {
  id: string;
  level: 'ok' | 'warn' | 'block';
  title: string;
  detail: string;
}

export interface Checklist {
  items: CheckItem[];
  /** True when nothing blocks the send. Warnings never block. */
  ready: boolean;
  audience: number;
  /** Rough hours the send will take at the install's hourly limit. */
  hours: number;
}

const SPAM_WORDS = /\b(free money|act now|click here|100% free|winner|guaranteed|no obligation|risk[- ]free|urgent)\b/i;

export async function checkBroadcast(ctx: Ctx, b: Broadcast, now = Date.now()): Promise<Checklist> {
  const items: CheckItem[] = [];
  const add = (id: string, level: CheckItem['level'], title: string, detail = '') => items.push({ id, level, title, detail });
  const list: List | null = await ctx.db.get<List>('mail_lists', b.list_id);
  const [mail, settings, fields, audience] = await Promise.all([
    emailStatus(ctx.env),
    getMailSettings(ctx.env, ctx.org.id),
    listFields(ctx),
    list ? audienceCount(ctx, b.list_id, parseFilter(b.filter), now) : Promise.resolve(0),
  ]);

  if (!list) add('list', 'block', 'The newsletter was deleted', 'Pick another newsletter for this email.');
  mail.mode === 'live' ? add('sender', 'ok', 'Email sending is set up') : mail.mode === 'dev' ? add('sender', 'warn', 'Email is in test mode', 'Messages are written to the log and not delivered. Finish setup on the Email screen to send for real.') : add('sender', 'block', 'Email sending is not set up', 'Open the Email screen and finish setup. Until then nothing can be delivered.');
  b.subject.trim() ? add('subject', 'ok', 'The email has a subject') : add('subject', 'block', 'The email has no subject');
  if (b.subject.length > 70) add('subject_len', 'warn', 'The subject is long', 'Many inboxes cut it off after about 70 characters.');
  if (/[A-Z]{6,}/.test(b.subject) || /!{2,}/.test(b.subject) || SPAM_WORDS.test(b.subject)) add('subject_spam', 'warn', 'The subject looks like spam', 'All capitals, repeated exclamation marks and phrases such as "act now" can send mail to the spam folder.');
  b.body.trim() ? add('body', 'ok', 'The email has content') : add('body', 'block', 'The email is empty');
  settings.postalAddress.trim()
    ? add('address', 'ok', 'Your postal address is in the footer')
    : add('address', 'block', 'Add your postal address', 'Most countries require a real postal address in every marketing email. Add it in Mail settings.');
  add('unsubscribe', 'ok', 'Every email carries an unsubscribe link', 'It is added automatically, along with the one-click unsubscribe header.');
  audience > 0 ? add('audience', 'ok', `${audience} ${audience === 1 ? 'person' : 'people'} will get this`) : add('audience', 'block', 'Nobody will get this email', 'Nobody is subscribed, or the segment matches no one.');

  // Merge tags that can come out empty or do not exist.
  const known = new Set<string>([...SYSTEM_TAGS, ...fields.map((f) => f.key)]);
  const tags = [...findTags(b.subject), ...findTags(b.preheader), ...findTags(b.body)];
  const unknown = [...new Set(tags.filter((t) => !known.has(t.name)).map((t) => t.name))];
  if (unknown.length) add('tags_unknown', 'block', `Unknown merge tag${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, 'Define the field first, or remove the tag. Otherwise people would see it raw or empty.');
  const risky = [...new Set(tags.filter((t) => t.fallback === null && !['email', 'list_name', 'unsubscribe_url', 'preferences_url'].includes(t.name) && known.has(t.name)).map((t) => t.name))];
  if (risky.length) add('tags_fallback', 'warn', `No fallback for: ${risky.join(', ')}`, 'If a person has no value, the tag is empty. Add a fallback such as {{first_name|there}}.');

  const links = linksIn(b);
  const local = links.filter((u) => /^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(u));
  if (local.length) add('links_local', 'block', 'A link points to your own computer', `${local[0]} will not open for anyone else.`);
  else if (links.length === 0) add('links', 'warn', 'The email has no links', 'That is fine for a letter, but most newsletters link somewhere.');
  if (/<img\b(?![^>]*\balt=)/i.test(b.body) || /!\[\s*\]\(/.test(b.body)) add('alt', 'warn', 'An image has no description', 'Add alt text so screen readers and blocked images still make sense.');
  if (b.format === 'html' && /<\s*(script|iframe|form|object|embed)\b/i.test(b.body)) add('html_unsafe', 'warn', 'Some HTML will be removed', 'Scripts, forms and frames are stripped from every email.');

  b.last_test_at ? add('test', 'ok', 'You sent yourself a test') : add('test', 'warn', 'You have not sent a test yet', 'Send one to yourself and check it on your phone.');
  const hours = Math.ceil(audience / HOURLY_CAP);
  if (hours > 1) add('pace', 'warn', `This will take about ${hours} hours`, `Sending is paced at about ${HOURLY_CAP} an hour on this install. It finishes on its own; you can close the page.`);
  if (b.track_opens || b.track_clicks) add('tracking', 'warn', 'Tracking is on', 'Subscribers are told in the email footer. Turn it off if you do not need it.');

  return { items, ready: !items.some((i) => i.level === 'block'), audience, hours };
}

export async function checkById(ctx: Ctx, id: string, now = Date.now()): Promise<Checklist & { broadcast: Broadcast }> {
  const broadcast = await getBroadcast(ctx, id);
  return { ...(await checkBroadcast(ctx, broadcast, now)), broadcast };
}

export { emit };
export type { Env };
