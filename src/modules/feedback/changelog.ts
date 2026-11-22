/** Changelog entries, scheduled publishing, linked posts, subscribers, digests and admin images. */
import { newId, orgDb, parseJson } from '../../core/db';
import { emailStatus, sendEmail } from '../../core/email';
import { enforceRateLimit } from '../../core/ratelimit';
import type { Env } from '../../env';
import { renderMail } from './emails';
import { fbErrors } from './errors';
import { emitFb } from './events';
import { readSignedToken, signedToken } from './lib';
import { excerpt } from './lib';
import { queueNotice, subscriberUnsubUrl } from './notify';
import { changeStatus } from './posts';
import { doneStatus, type Ctx } from './portal';
import type { Entry, EntryState, Page, Portal, Subscriber } from './types';
import { clamp, decodeCursor, encodeCursor, isEmail, normaliseEmail, randomSuffix, slugify } from './util';

export const LABELS = ['New', 'Improved', 'Fixed', 'Announcement'];
export const IMAGE_MAX = 2 * 1024 * 1024;
export const IMAGE_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

export interface EntryInput {
  title: string;
  body?: string;
  labels?: string[];
  state?: EntryState;
  publish_at?: number | null;
  complete_posts?: boolean;
  author_name?: string;
  post_ids?: string[];
}

export function entryLabels(e: Entry): string[] {
  return parseJson<string[]>(e.labels, []);
}

function cleanLabels(labels: string[] | undefined): string[] {
  return [...new Set((labels ?? []).map((l) => l.trim().slice(0, 24)).filter(Boolean))].slice(0, 5);
}

export async function listEntries(ctx: Ctx, opts: { state?: EntryState | 'all'; cursor?: string | null; limit?: number } = {}): Promise<Page<Entry>> {
  const limit = clamp(opts.limit ?? 20, 1, 100);
  const where = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.state && opts.state !== 'all') (where.push('state = ?'), params.push(opts.state));
  const cur = decodeCursor(opts.cursor);
  if (cur && typeof cur[0] === 'number' && typeof cur[1] === 'string') {
    where.push('(COALESCE(published_at, created_at) < ? OR (COALESCE(published_at, created_at) = ? AND id < ?))');
    params.push(cur[0], cur[0], cur[1]);
  }
  const rows = await ctx.db.all<Entry>(`SELECT * FROM fb_entries WHERE ${where.join(' AND ')} ORDER BY COALESCE(published_at, created_at) DESC, id DESC LIMIT ?`, ...params, limit + 1);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? encodeCursor([last.published_at ?? last.created_at, last.id]) : null };
}

export const getEntry = (ctx: Ctx, id: string) => ctx.db.get<Entry>('fb_entries', id);
export const entryBySlug = (ctx: Ctx, slug: string) => ctx.db.findOne<Entry>('fb_entries', { slug });

export async function linkedPostIds(ctx: Ctx, entryId: string): Promise<string[]> {
  const rows = await ctx.db.all<{ post_id: string }>('SELECT post_id FROM fb_entry_posts WHERE org_id = :org AND entry_id = ?', entryId);
  return rows.map((r) => r.post_id);
}

export async function linkedPosts(ctx: Ctx, entryId: string): Promise<{ id: string; title: string; slug: string }[]> {
  return ctx.db.all(
    'SELECT p.id, p.title, p.slug FROM fb_entry_posts ep JOIN fb_posts p ON p.id = ep.post_id WHERE ep.org_id = :org AND ep.entry_id = ? ORDER BY p.title',
    entryId,
  );
}

async function setLinks(ctx: Ctx, entryId: string, postIds: string[]): Promise<void> {
  const ids = postIds.length ? await ctx.db.all<{ id: string }>(`SELECT id FROM fb_posts WHERE org_id = :org AND id IN (${postIds.map(() => '?').join(',')})`, ...postIds) : [];
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM fb_entry_posts WHERE org_id = ?1 AND entry_id = ?2').bind(ctx.orgId, entryId),
    ...ids.map((r) => ctx.env.DB.prepare('INSERT INTO fb_entry_posts (org_id, entry_id, post_id) VALUES (?1, ?2, ?3)').bind(ctx.orgId, entryId, r.id)),
  ]);
}

async function freeEntrySlug(ctx: Ctx, title: string): Promise<string> {
  const base = slugify(title, 50, 'update');
  for (let i = 0; i < 6; i++) {
    const slug = i === 0 ? base : `${base}-${randomSuffix(4)}`;
    if (!(await ctx.db.findOne('fb_entries', { slug }))) return slug;
  }
  return `${base}-${randomSuffix(8)}`;
}

function cleanEntry(input: Partial<EntryInput>): Record<string, string | number | null> {
  const out: Record<string, string | number | null> = {};
  if (input.title !== undefined) {
    const t = input.title.replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 140) throw fbErrors.entry_missing('Give the update a title between 3 and 140 characters.');
    out.title = t;
  }
  if (input.body !== undefined) {
    if (input.body.length > 20000) throw fbErrors.entry_missing('Keep the update under 20,000 characters.');
    out.body = input.body.replace(/\r\n/g, '\n');
  }
  if (input.labels !== undefined) out.labels = JSON.stringify(cleanLabels(input.labels));
  if (input.author_name !== undefined) out.author_name = input.author_name.trim().slice(0, 60);
  if (input.complete_posts !== undefined) out.complete_posts = input.complete_posts ? 1 : 0;
  if (input.publish_at !== undefined) out.publish_at = input.publish_at;
  return out;
}

export async function createEntry(ctx: Ctx, input: EntryInput, actor: { name: string }): Promise<Entry> {
  const fields = cleanEntry(input);
  if (!fields.title) throw fbErrors.entry_missing('Give the update a title.');
  const now = Date.now();
  let state: EntryState = input.state ?? 'draft';
  if (state === 'scheduled' && (!input.publish_at || input.publish_at <= now)) state = input.publish_at ? 'published' : 'draft';
  const entry = await ctx.db.insert<Entry>('fb_entries', {
    id: newId('fbe', now),
    slug: await freeEntrySlug(ctx, String(fields.title)),
    title: fields.title,
    body: fields.body ?? '',
    labels: fields.labels ?? '[]',
    state: state === 'published' ? 'draft' : state,
    publish_at: state === 'scheduled' ? input.publish_at ?? null : null,
    published_at: null,
    mailed_at: null,
    complete_posts: fields.complete_posts ?? 1,
    author_name: fields.author_name ?? actor.name,
    sample: 0,
    created_at: now,
    updated_at: now,
  });
  await setLinks(ctx, entry.id, input.post_ids ?? []);
  return state === 'published' ? publishEntry(ctx, entry.id) : entry;
}

export async function updateEntry(ctx: Ctx, id: string, input: Partial<EntryInput>): Promise<Entry> {
  const entry = await getEntry(ctx, id);
  if (!entry) throw fbErrors.entry_missing();
  const fields = cleanEntry(input);
  let publishNow = false;
  if (input.state !== undefined && input.state !== entry.state) {
    if (input.state === 'published' && entry.state !== 'published') publishNow = true;
    else if (input.state === 'draft') (fields.state = 'draft', (fields.publish_at = null));
    else if (input.state === 'scheduled') {
      const at = input.publish_at ?? entry.publish_at;
      if (!at) throw fbErrors.entry_missing('Pick a date and time to schedule it.');
      if (at <= Date.now()) publishNow = true;
      else (fields.state = 'scheduled', (fields.publish_at = at));
    }
  } else if (entry.state === 'scheduled' && input.publish_at) {
    if (input.publish_at <= Date.now()) publishNow = true;
  }
  if (entry.state === 'published') delete fields.publish_at;
  const row = (await ctx.db.update<Entry>('fb_entries', id, { ...fields, updated_at: Date.now() }))!;
  if (input.post_ids) await setLinks(ctx, id, input.post_ids);
  return publishNow ? publishEntry(ctx, id) : row;
}

export async function deleteEntry(ctx: Ctx, id: string): Promise<void> {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM fb_entry_posts WHERE org_id = ?1 AND entry_id = ?2').bind(ctx.orgId, id),
    ctx.env.DB.prepare('DELETE FROM fb_entries WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id),
  ]);
}

/**
 * Publish an entry now. Linked posts move to the first "done" status (unless switched off) and their
 * followers hear it shipped. Safe to call twice: a published entry is returned as it is.
 */
export async function publishEntry(ctx: Ctx, id: string, actor = { id: null as string | null, name: 'The team' }): Promise<Entry> {
  const entry = await getEntry(ctx, id);
  if (!entry) throw fbErrors.entry_missing();
  if (entry.state === 'published') return entry;
  const now = Date.now();
  const claimed = await ctx.db.run("UPDATE fb_entries SET state = 'published', published_at = ?, publish_at = NULL, updated_at = ? WHERE org_id = :org AND id = ? AND state <> 'published'", now, now, id);
  if (claimed.changes === 0) return (await getEntry(ctx, id))!;
  const posts = await linkedPosts(ctx, id);
  if (posts.length) {
    const done = await doneStatus(ctx);
    for (const p of posts) {
      if (entry.complete_posts && done) await changeStatus(ctx, p.id, done.id, actor, { silent: true });
      await queueNotice(ctx.env, ctx.orgId, { kind: 'shipped', postId: p.id, entryId: id, payload: { entryTitle: entry.title, entrySlug: entry.slug }, origin: ctx.origin });
    }
  }
  await emitFb(ctx.env, ctx.orgId, 'changelog.published', id, { title: entry.title, slug: entry.slug, posts: posts.length });
  await queueNotice(ctx.env, ctx.orgId, { kind: 'entry', entryId: id, payload: { title: entry.title, slug: entry.slug, excerpt: excerpt(entry.body, 240) }, origin: ctx.origin });
  await ctx.db.run('UPDATE fb_entries SET mailed_at = ? WHERE org_id = :org AND id = ?', now, id);
  return (await getEntry(ctx, id))!;
}

/** Run every minute: publish scheduled entries whose time has come, across all workspaces. */
export async function publishDue(env: Env, now = Date.now()): Promise<number> {
  const { results } = await env.DB.prepare("SELECT id, org_id FROM fb_entries WHERE state = 'scheduled' AND publish_at <= ?1 ORDER BY publish_at LIMIT 20").bind(now).all<{ id: string; org_id: string }>();
  for (const r of results) {
    await publishEntry({ env, orgId: r.org_id, db: orgDb(env.DB, r.org_id) }, r.id);
  }
  return results.length;
}

// ---------------------------------------------------------------------------------------------
// Subscribers
// ---------------------------------------------------------------------------------------------

export async function listSubscribers(ctx: Ctx, opts: { status?: string; limit?: number; offset?: number } = {}): Promise<Subscriber[]> {
  const where = ['org_id = :org'];
  const params: (string | number)[] = [];
  if (opts.status) (where.push('status = ?'), params.push(opts.status));
  return ctx.db.all<Subscriber>(`SELECT * FROM fb_subscribers WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...params, clamp(opts.limit ?? 100, 1, 500), opts.offset ?? 0);
}

export async function subscriberCounts(ctx: Ctx): Promise<{ active: number; pending: number; unsubscribed: number }> {
  const rows = await ctx.db.all<{ status: string; n: number }>('SELECT status, COUNT(*) AS n FROM fb_subscribers WHERE org_id = :org GROUP BY status');
  const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return { active: get('active'), pending: get('pending'), unsubscribed: get('unsubscribed') };
}

/** Start a double opt-in. Nothing is sent to the address until they click the link in the confirmation email. */
export async function subscribe(ctx: Ctx, portal: Portal, emailInput: string, frequency: string, ip: string, origin: string): Promise<{ sent: boolean }> {
  const email = normaliseEmail(emailInput);
  if (!isEmail(email)) throw fbErrors.email_invalid();
  const freq = ['each', 'weekly', 'monthly'].includes(frequency) ? (frequency as Subscriber['frequency']) : 'each';
  if (!((await emailStatus(ctx.env)).status === 'ready')) throw fbErrors.sign_in_needed('Email is not set up for this site, so it cannot send confirmations yet.');
  await enforceRateLimit(ctx.env, `feedback.subscribe:ip:${ip}`, { limit: 10, windowSec: 3600 });
  await enforceRateLimit(ctx.env, `feedback.subscribe:email:${ctx.orgId}:${email}`, { limit: 3, windowSec: 3600 });
  let sub = await ctx.db.findOne<Subscriber>('fb_subscribers', { email });
  const now = Date.now();
  if (!sub) {
    sub = await ctx.db.insert<Subscriber>('fb_subscribers', { id: newId('fbs2', now), email, status: 'pending', frequency: freq, sample: 0, created_at: now, confirmed_at: null, last_sent_at: null });
  } else if (sub.status === 'active') {
    await ctx.db.update('fb_subscribers', sub.id, { frequency: freq });
    return { sent: false };
  } else {
    await ctx.db.update('fb_subscribers', sub.id, { status: 'pending', frequency: freq });
  }
  const token = await signedToken(ctx.env, 'feedback-sub', { o: ctx.orgId, s: sub.id, a: 'confirm' }, 7 * 24 * 3600);
  const mail = await renderMail(ctx.env, ctx.orgId, {
    subject: `Confirm your subscription to ${portal.name}`,
    heading: 'Confirm your subscription',
    paragraphs: [`Click the button to get product updates from ${portal.name} by email. If you did not ask for this, ignore the message and nothing will be sent.`],
    button: { label: 'Confirm subscription', href: `${origin}/changelog/${portal.slug}/confirm?t=${token}` },
    unsubscribe: { href: await subscriberUnsubUrl(ctx.env, origin, portal, sub.id), label: 'Never email me' },
  });
  await sendEmail(ctx.env, { orgId: ctx.orgId, to: email, subject: mail.subject, html: mail.html, text: mail.text, template: 'feedback-confirm', tag: 'feedback' });
  return { sent: true };
}

export async function confirmSubscriber(env: Env, token: string): Promise<{ portalOrg: string; email: string } | null> {
  const body = await readSignedToken<{ o: string; s: string; a: string }>(env, 'feedback-sub', token);
  if (!body || body.a !== 'confirm') return null;
  const ctx: Ctx = { env, orgId: body.o, db: orgDb(env.DB, body.o) };
  const sub = await ctx.db.get<Subscriber>('fb_subscribers', body.s);
  if (!sub || sub.status === 'unsubscribed') return null;
  if (sub.status !== 'active') await ctx.db.update('fb_subscribers', sub.id, { status: 'active', confirmed_at: Date.now() });
  return { portalOrg: body.o, email: sub.email };
}

export async function unsubscribeSubscriber(env: Env, token: string): Promise<boolean> {
  const body = await readSignedToken<{ o: string; s: string }>(env, 'feedback-sub', token);
  if (!body) return false;
  const db = orgDb(env.DB, body.o);
  await db.update('fb_subscribers', body.s, { status: 'unsubscribed' });
  return true;
}

export async function removeSubscriber(ctx: Ctx, id: string): Promise<void> {
  await ctx.db.remove('fb_subscribers', id);
}

/** Weekly or monthly digest for subscribers who chose one. Returns how many entries it covered. */
export async function queueDigest(env: Env, orgId: string, frequency: 'weekly' | 'monthly', now = Date.now()): Promise<number> {
  const db = orgDb(env.DB, orgId);
  const since = now - (frequency === 'weekly' ? 7 : 31) * 24 * 3600 * 1000;
  const entries = await db.all<Entry>("SELECT * FROM fb_entries WHERE org_id = :org AND state = 'published' AND published_at >= ? ORDER BY published_at DESC LIMIT 10", since);
  if (entries.length === 0) return 0;
  const has = await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM fb_subscribers WHERE org_id = :org AND status = 'active' AND frequency = ?", frequency);
  if (!has?.n) return 0;
  await queueNotice(env, orgId, { kind: 'digest', payload: { frequency, entries: entries.map((e) => ({ title: e.title, slug: e.slug, excerpt: excerpt(e.body, 160) })) } });
  return entries.length;
}

// ---------------------------------------------------------------------------------------------
// Admin images
// ---------------------------------------------------------------------------------------------

/** Store an image in R2 under feedback/<orgId>/ and return its public path. */
export async function saveImage(ctx: Ctx, portal: Portal, bytes: ArrayBuffer, contentType: string): Promise<{ id: string; url: string }> {
  const ext = IMAGE_TYPES[contentType];
  if (!ext) throw fbErrors.image_invalid('Use a PNG, JPEG, GIF or WebP image.');
  if (bytes.byteLength > IMAGE_MAX) throw fbErrors.image_invalid('Keep images under 2 MB.');
  if (bytes.byteLength < 16) throw fbErrors.image_invalid('That file looks empty.');
  const id = newId('fbi');
  const key = `feedback/${ctx.orgId}/${id}.${ext}`;
  await ctx.env.FILES.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
  await ctx.db.insert('fb_images', { id, r2_key: key, content_type: contentType, size: bytes.byteLength, created_at: Date.now() });
  return { id, url: `/changelog/${portal.slug}/img/${id}.${ext}` };
}

export async function readImage(env: Env, orgId: string, idWithExt: string): Promise<{ body: ReadableStream; type: string } | null> {
  const id = idWithExt.replace(/\.[a-z0-9]+$/i, '');
  const row = await env.DB.prepare('SELECT r2_key, content_type FROM fb_images WHERE org_id = ?1 AND id = ?2').bind(orgId, id).first<{ r2_key: string; content_type: string }>();
  if (!row) return null;
  const obj = await env.FILES.get(row.r2_key);
  return obj ? { body: obj.body, type: row.content_type } : null;
}
