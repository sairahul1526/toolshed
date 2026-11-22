/**
 * People: adding, signing up, confirming, unsubscribing, tags, CSV import and export.
 *
 * Consent rules the code holds to:
 *  - A public signup is `pending` until the person clicks the confirmation link (double opt-in is
 *    the default; a newsletter can switch it off).
 *  - An import needs the importer to confirm consent, never sends a confirmation email by itself,
 *    and never lifts a suppression.
 *  - Every unsubscribe writes a suppression, so a later import or signup form cannot undo it silently.
 */
import { z } from 'zod';
import { newId, parseJson } from '../../core/db';
import { isValidAddress, normaliseAddress } from '../../core/email';
import { toCsv } from '../../core/csv';
import { guessColumns, parseCsv } from '../../core/csv-parse';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import { mailErrors } from './errors';
import { sendConfirmEmail } from './emails';
import { getList, listFields } from './lists';
import { enrollSubscriber } from './sequences';
import { compileFilter, EMPTY_FILTER, type Filter } from './segments';
import { coreSender, type Sender } from './sender';
import { isSuppressed, suppress } from './suppression';
import type { Ctx, List, Membership, MembershipStatus, Subscriber } from './types';

export const CONFIRM_RESEND_MS = 10 * 60_000;
export const IMPORT_MAX_ROWS = 1000;

const TAG = z.string().trim().toLowerCase().min(1).max(40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u, 'Tags use letters, numbers, spaces, dashes and underscores.');
export const tagsSchema = z.array(TAG).max(20);

export interface Deps {
  sender?: Sender;
  now?: number;
  /** The public address of the install, for links in emails. */
  base: string;
}

export const emailOf = (raw: unknown): string => {
  const email = normaliseAddress(String(raw ?? ''));
  if (!isValidAddress(email)) throw errors.validation_failed('That email address doesn’t look right.', { email: 'Enter a full address such as sam@example.com.' });
  return email;
};

const cleanFields = (raw: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^[a-z][a-z0-9_]{0,40}$/.test(k) && (typeof v === 'string' || typeof v === 'number')) out[k] = String(v).slice(0, 300);
    }
  }
  return out;
};

export const fieldsOf = (sub: Pick<Subscriber, 'fields'>): Record<string, string> => parseJson<Record<string, string>>(sub.fields, {});

// -- reading ------------------------------------------------------------------------------------

export interface SubscriberRow extends Subscriber {
  status: MembershipStatus | null;
  tags: string | null;
}

export interface SubscriberQuery {
  listId?: string;
  status?: MembershipStatus | 'suppressed';
  tag?: string;
  q?: string;
  segment?: Filter;
  limit?: number;
  offset?: number;
}

export async function querySubscribers(ctx: Ctx, q: SubscriberQuery, now = Date.now()): Promise<{ items: SubscriberRow[]; total: number }> {
  const where: string[] = ['s.org_id = :org'];
  const params: (string | number)[] = [];
  const join = q.listId ? 'JOIN mail_memberships m ON m.org_id = s.org_id AND m.subscriber_id = s.id AND m.list_id = ?' : 'LEFT JOIN mail_memberships m ON m.org_id = s.org_id AND m.subscriber_id = s.id';
  const joinParams: (string | number)[] = q.listId ? [q.listId] : [];
  if (q.status === 'suppressed') where.push("EXISTS (SELECT 1 FROM mail_suppressions x WHERE x.org_id = s.org_id AND x.email = s.email)");
  else if (q.status) {
    where.push('m.status = ?');
    params.push(q.status);
  }
  if (q.tag) {
    where.push('EXISTS (SELECT 1 FROM mail_subscriber_tags t WHERE t.org_id = s.org_id AND t.subscriber_id = s.id AND t.tag = ?)');
    params.push(q.tag.toLowerCase());
  }
  if (q.q) {
    where.push("(s.email LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\')");
    const like = `%${q.q.toLowerCase().replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like);
  }
  if (q.segment) {
    const c = compileFilter(q.segment, now);
    where.push(c.sql);
    params.push(...c.params);
  }
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
  const offset = Math.max(q.offset ?? 0, 0);
  const body = `FROM mail_subscribers s ${join} WHERE ${where.join(' AND ')}`;
  const [items, count] = await Promise.all([
    ctx.db.all<SubscriberRow>(
      `SELECT s.*, ${q.listId ? 'm.status' : 'MIN(m.status)'} AS status,
        (SELECT group_concat(tag, ',') FROM mail_subscriber_tags t WHERE t.org_id = s.org_id AND t.subscriber_id = s.id) AS tags
       ${body} ${q.listId ? '' : 'GROUP BY s.id'} ORDER BY s.created_at DESC, s.id DESC LIMIT ${limit} OFFSET ${offset}`,
      ...joinParams,
      ...params,
    ),
    ctx.db.first<{ n: number }>(`SELECT COUNT(DISTINCT s.id) AS n ${body}`, ...joinParams, ...params),
  ]);
  return { items, total: count?.n ?? 0 };
}

export interface SubscriberDetail {
  subscriber: Subscriber;
  fields: Record<string, string>;
  tags: string[];
  memberships: (Membership & { list_name: string })[];
  suppressions: { list_id: string; reason: string }[];
}

export async function getSubscriber(ctx: Ctx, id: string): Promise<SubscriberDetail> {
  const subscriber = await ctx.db.get<Subscriber>('mail_subscribers', id);
  if (!subscriber) throw mailErrors.subscriber_not_found();
  const [tags, memberships, suppressions] = await Promise.all([
    ctx.db.all<{ tag: string }>('SELECT tag FROM mail_subscriber_tags WHERE org_id = :org AND subscriber_id = ? ORDER BY tag', id),
    ctx.db.all<Membership & { list_name: string }>(
      'SELECT m.*, l.name AS list_name FROM mail_memberships m JOIN mail_lists l ON l.id = m.list_id WHERE m.org_id = :org AND m.subscriber_id = ? ORDER BY m.joined_at',
      id,
    ),
    ctx.db.all<{ list_id: string; reason: string }>('SELECT list_id, reason FROM mail_suppressions WHERE org_id = :org AND email = ?', subscriber.email),
  ]);
  return { subscriber, fields: fieldsOf(subscriber), tags: tags.map((t) => t.tag), memberships, suppressions };
}

export const findSubscriber = (ctx: Ctx, email: string) => ctx.db.findOne<Subscriber>('mail_subscribers', { email: normaliseAddress(email) });

// -- writing ------------------------------------------------------------------------------------

async function setTagsFor(ctx: Ctx, subscriberId: string, tags: string[]): Promise<void> {
  if (tags.length === 0) return;
  await ctx.db.d1.batch(
    tags.map((tag) => ctx.db.d1.prepare('INSERT OR IGNORE INTO mail_subscriber_tags (org_id, subscriber_id, tag) VALUES (?1, ?2, ?3)').bind(ctx.org.id, subscriberId, tag)),
  );
}

export async function replaceTags(ctx: Ctx, subscriberId: string, raw: unknown): Promise<string[]> {
  const tags = [...new Set(parse(tagsSchema, raw))];
  await getSubscriber(ctx, subscriberId);
  await ctx.db.run('DELETE FROM mail_subscriber_tags WHERE org_id = :org AND subscriber_id = ?', subscriberId);
  await setTagsFor(ctx, subscriberId, tags);
  return tags;
}

export const addTagToMany = async (ctx: Ctx, subscriberIds: string[], tag: string): Promise<void> => {
  const t = parse(TAG, tag);
  for (let i = 0; i < subscriberIds.length; i += 100) {
    await ctx.db.d1.batch(subscriberIds.slice(i, i + 100).map((id) => ctx.db.d1.prepare('INSERT OR IGNORE INTO mail_subscriber_tags (org_id, subscriber_id, tag) VALUES (?1, ?2, ?3)').bind(ctx.org.id, id, t)));
  }
};

interface Joined {
  subscriber: Subscriber;
  created: boolean;
}

async function ensureSubscriber(ctx: Ctx, input: { email: string; name?: string; fields?: Record<string, string>; source: string; consentNote: string }, now: number): Promise<Joined> {
  const existing = await findSubscriber(ctx, input.email);
  if (!existing) {
    const subscriber = await ctx.db.insert<Subscriber>('mail_subscribers', {
      id: newId('msb', now),
      email: input.email,
      name: (input.name ?? '').slice(0, 120),
      fields: JSON.stringify(input.fields ?? {}),
      source: input.source,
      consent_note: input.consentNote,
      consent_at: now,
      created_at: now,
      updated_at: now,
    });
    await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'subscriber.created', subject: subscriber.id, data: { email: subscriber.email, source: input.source }, at: now });
    return { subscriber, created: true };
  }
  const merged = { ...fieldsOf(existing), ...(input.fields ?? {}) };
  const patch: Record<string, string | number> = { updated_at: now };
  if (!existing.name && input.name) patch.name = input.name.slice(0, 120);
  if (Object.keys(input.fields ?? {}).length) patch.fields = JSON.stringify(merged);
  const subscriber = (await ctx.db.update<Subscriber>('mail_subscribers', existing.id, patch))!;
  return { subscriber, created: false };
}

async function activate(ctx: Ctx, list: List, sub: Subscriber, now: number): Promise<void> {
  const row = await ctx.db.findOne<Membership>('mail_memberships', { list_id: list.id, subscriber_id: sub.id });
  if (row?.status === 'active') return;
  if (row) {
    await ctx.db.run("UPDATE mail_memberships SET status = 'active', confirmed_at = ?, unsubscribed_at = NULL WHERE org_id = :org AND list_id = ? AND subscriber_id = ?", now, list.id, sub.id);
  } else {
    await ctx.db.insert('mail_memberships', { list_id: list.id, subscriber_id: sub.id, status: 'active', joined_at: now, confirmed_at: now });
  }
  // The person asked to be here again, so an earlier unsubscribe from this newsletter no longer applies.
  await ctx.db.run("DELETE FROM mail_suppressions WHERE org_id = :org AND email = ? AND list_id = ? AND reason = 'unsubscribed'", sub.email, list.id);
  await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'subscriber.confirmed', subject: sub.id, data: { email: sub.email, list: list.slug }, at: now });
  await enrollSubscriber(ctx, list.id, sub.id, now);
}

export type JoinOutcome = 'active' | 'pending' | 'blocked';

export interface JoinInput {
  email: unknown;
  name?: unknown;
  fields?: unknown;
  tags?: unknown;
  source?: string;
  /** The caller vouches that the person agreed (added by hand or from your own app): skip the confirmation click. */
  confirmed?: boolean;
}

/**
 * Add a person to a newsletter. A public signup form calls this with `confirmed: false`; the dashboard and API
 * call it with what the caller says about consent. Returns what happened without saying why
 * (a public page must not reveal who is already on the list).
 */
export async function joinList(ctx: Ctx, list: List, input: JoinInput, deps: Deps): Promise<{ outcome: JoinOutcome; subscriber: Subscriber | null; created: boolean }> {
  const now = deps.now ?? Date.now();
  const email = emailOf(input.email);
  const existingSuppression = await isSuppressed(ctx, email, list.id);
  if (existingSuppression && existingSuppression.reason !== 'unsubscribed') return { outcome: 'blocked', subscriber: null, created: false };
  const source = (input.source ?? 'manual').slice(0, 40);
  const confirmed = input.confirmed === true;
  const { subscriber, created } = await ensureSubscriber(
    ctx,
    {
      email,
      ...(typeof input.name === 'string' ? { name: input.name.trim() } : {}),
      fields: cleanFields(input.fields),
      source,
      consentNote: confirmed ? `Added by an admin (${source})` : `Signed up on ${list.slug}`,
    },
    now,
  );
  const tags = [...new Set(parse(tagsSchema, input.tags ?? []))];
  await setTagsFor(ctx, subscriber.id, tags);
  const membership = await ctx.db.findOne<Membership>('mail_memberships', { list_id: list.id, subscriber_id: subscriber.id });
  if (membership?.status === 'active') return { outcome: 'active', subscriber, created };

  if (confirmed || !list.double_opt_in) {
    await activate(ctx, list, subscriber, now);
    return { outcome: 'active', subscriber, created };
  }
  if (!membership) await ctx.db.insert('mail_memberships', { list_id: list.id, subscriber_id: subscriber.id, status: 'pending', joined_at: now });
  else if (membership.status === 'unsubscribed') {
    await ctx.db.run("UPDATE mail_memberships SET status = 'pending', unsubscribed_at = NULL WHERE org_id = :org AND list_id = ? AND subscriber_id = ?", list.id, subscriber.id);
  }
  const recent = membership?.confirm_sent_at && now - membership.confirm_sent_at < CONFIRM_RESEND_MS;
  if (!recent) {
    await ctx.db.run('UPDATE mail_memberships SET confirm_sent_at = ? WHERE org_id = :org AND list_id = ? AND subscriber_id = ?', now, list.id, subscriber.id);
    await sendConfirmEmail(ctx.env, deps.sender ?? coreSender(ctx.env), list, subscriber, deps.base);
  }
  return { outcome: 'pending', subscriber, created };
}

/** The person clicked the link in the confirmation email. Safe to repeat. */
export async function confirmSubscription(ctx: Ctx, t: { s: string; l: string }, now = Date.now()): Promise<{ list: List; subscriber: Subscriber } | null> {
  const [list, subscriber] = await Promise.all([ctx.db.get<List>('mail_lists', t.l), ctx.db.get<Subscriber>('mail_subscribers', t.s)]);
  if (!list || !subscriber) return null;
  if (await isSuppressedHard(ctx, subscriber.email, list.id)) return null;
  const membership = await ctx.db.findOne<Membership>('mail_memberships', { list_id: list.id, subscriber_id: subscriber.id });
  if (!membership) return null;
  await activate(ctx, list, subscriber, now);
  return { list, subscriber };
}

async function isSuppressedHard(ctx: Ctx, email: string, listId: string): Promise<boolean> {
  const row = await isSuppressed(ctx, email, listId);
  return !!row && row.reason !== 'unsubscribed';
}

/** Leave one newsletter. Writes a suppression so no import or form can quietly add the person back. */
export async function unsubscribe(ctx: Ctx, t: { s: string; l: string }, reason: 'unsubscribed' | 'manual' = 'unsubscribed', now = Date.now()): Promise<boolean> {
  const subscriber = await ctx.db.get<Subscriber>('mail_subscribers', t.s);
  if (!subscriber) return false;
  const { changes } = await ctx.db.run(
    "UPDATE mail_memberships SET status = 'unsubscribed', unsubscribed_at = ? WHERE org_id = :org AND list_id = ? AND subscriber_id = ? AND status <> 'unsubscribed'",
    now,
    t.l,
    t.s,
  );
  await suppress(ctx, { email: subscriber.email, listId: t.l, reason, note: reason === 'manual' ? 'Removed by an admin' : 'Used the unsubscribe link', now });
  // Cancel the welcome emails still waiting for this person on this newsletter.
  await ctx.db.run("UPDATE mail_enrollments SET status = 'cancelled' WHERE org_id = :org AND subscriber_id = ? AND status = 'active' AND sequence_id IN (SELECT id FROM mail_sequences WHERE org_id = :org AND list_id = ?)", t.s, t.l);
  if (changes > 0) {
    await emit(ctx.env, { orgId: ctx.org.id, module: 'mail', name: 'subscriber.unsubscribed', subject: subscriber.id, data: { email: subscriber.email, list: t.l }, at: now });
  }
  return changes > 0;
}

export async function updateSubscriber(ctx: Ctx, id: string, raw: { name?: unknown; fields?: unknown; tags?: unknown }, now = Date.now()): Promise<SubscriberDetail> {
  const detail = await getSubscriber(ctx, id);
  const patch: Record<string, string | number> = { updated_at: now };
  if (typeof raw.name === 'string') patch.name = raw.name.trim().slice(0, 120);
  if (raw.fields !== undefined) patch.fields = JSON.stringify({ ...detail.fields, ...cleanFields(raw.fields) });
  await ctx.db.update('mail_subscribers', id, patch);
  if (raw.tags !== undefined) await replaceTags(ctx, id, raw.tags);
  return getSubscriber(ctx, id);
}

/** Erase a person. Their address stays on the suppression list if they had unsubscribed or bounced, so we never mail them again. */
export async function deleteSubscriber(ctx: Ctx, id: string): Promise<void> {
  await getSubscriber(ctx, id);
  const d1 = ctx.db.d1;
  const org = ctx.org.id;
  await d1.batch([
    d1.prepare('DELETE FROM mail_subscriber_tags WHERE org_id = ?1 AND subscriber_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_memberships WHERE org_id = ?1 AND subscriber_id = ?2').bind(org, id),
    d1.prepare('DELETE FROM mail_enrollments WHERE org_id = ?1 AND subscriber_id = ?2').bind(org, id),
    d1.prepare("UPDATE mail_deliveries SET email = '' WHERE org_id = ?1 AND subscriber_id = ?2").bind(org, id),
    d1.prepare('DELETE FROM mail_subscribers WHERE org_id = ?1 AND id = ?2').bind(org, id),
  ]);
}

// -- import ---------------------------------------------------------------------------------------

export interface ImportReport {
  total: number;
  added: number;
  already_subscribed: number;
  duplicates_in_file: number;
  invalid: number;
  suppressed: number;
  ignored_columns: string[];
  invalid_examples: string[];
  truncated: boolean;
}

const chunks = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const fieldKeyOf = (header: string) => header.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/**
 * Import people from a CSV. Everyone becomes active without a confirmation email: the importer
 * states that these people agreed, and that statement is stored as each person's consent note.
 * Written for the free plan: one read batch and a few write batches, whatever the file size.
 */
export async function importSubscribers(
  ctx: Ctx,
  input: { listId: string; csv: string; consent: boolean; tags?: unknown },
  now = Date.now(),
): Promise<ImportReport> {
  if (!input.consent) throw mailErrors.needs_consent();
  const list = await getList(ctx, input.listId);
  const extraTags = [...new Set(parse(tagsSchema, input.tags ?? []))];
  const parsed = parseCsv(input.csv, { maxRows: IMPORT_MAX_ROWS });
  if (parsed.headers.length === 0) throw errors.validation_failed('That file is empty.');
  const cols = guessColumns(parsed.headers, {
    email: ['email', 'email address', 'e-mail', 'mail'],
    name: ['name', 'full name', 'fullname'],
    first: ['first name', 'firstname', 'first'],
    last: ['last name', 'lastname', 'surname', 'last'],
    tags: ['tags', 'tag', 'labels'],
  });
  const emailCol = cols.email ?? null;
  const nameCol = cols.name ?? null;
  const firstCol = cols.first ?? null;
  const lastCol = cols.last ?? null;
  const tagsCol = cols.tags ?? null;
  if (emailCol === null) throw errors.validation_failed('We couldn’t find an email column. Name the first row of that column "email".');
  const defs = await listFields(ctx);
  const fieldAt = new Map<number, string>();
  const used = new Set(Object.values(cols).filter((v): v is number => typeof v === 'number'));
  parsed.headers.forEach((h, i) => {
    if (used.has(i)) return;
    const key = fieldKeyOf(h);
    if (defs.some((d) => d.key === key)) fieldAt.set(i, key);
  });
  const ignored = parsed.headers.filter((h, i) => h && !used.has(i) && !fieldAt.has(i));

  const report: ImportReport = { total: parsed.rows.length, added: 0, already_subscribed: 0, duplicates_in_file: 0, invalid: 0, suppressed: 0, ignored_columns: ignored, invalid_examples: [], truncated: parsed.truncated };
  interface Row { email: string; name: string; fields: Record<string, string>; tags: string[] }
  const rows = new Map<string, Row>();
  for (const cells of parsed.rows) {
    const email = normaliseAddress(cells[emailCol] ?? '');
    if (!isValidAddress(email)) {
      report.invalid++;
      if (report.invalid_examples.length < 5) report.invalid_examples.push((cells[emailCol] ?? '').slice(0, 60) || '(blank)');
      continue;
    }
    if (rows.has(email)) {
      report.duplicates_in_file++;
      continue;
    }
    const name = (nameCol !== null ? cells[nameCol] : [firstCol !== null ? cells[firstCol] : '', lastCol !== null ? cells[lastCol] : ''].filter(Boolean).join(' '))?.trim() ?? '';
    const fields: Record<string, string> = {};
    for (const [i, key] of fieldAt) if (cells[i]?.trim()) fields[key] = cells[i]!.trim().slice(0, 300);
    const rowTags = tagsCol !== null ? (cells[tagsCol] ?? '').split(/[,;|]/).map((t) => t.trim().toLowerCase()).filter((t) => TAG.safeParse(t).success) : [];
    rows.set(email, { email, name: name.slice(0, 120), fields, tags: [...new Set([...rowTags, ...extraTags])].slice(0, 20) });
  }

  const d1 = ctx.db.d1;
  const org = ctx.org.id;
  const emails = [...rows.keys()];
  const reads: D1PreparedStatement[] = [];
  for (const group of chunks(emails, 80)) {
    const marks = group.map((_, i) => `?${i + 3}`).join(',');
    reads.push(
      d1.prepare(`SELECT email FROM mail_suppressions WHERE org_id = ?1 AND list_id IN ('', ?2) AND email IN (${marks})`).bind(org, list.id, ...group),
      d1
        .prepare(`SELECT s.email FROM mail_subscribers s JOIN mail_memberships m ON m.org_id = s.org_id AND m.subscriber_id = s.id WHERE s.org_id = ?1 AND m.list_id = ?2 AND m.status = 'active' AND s.email IN (${marks})`)
        .bind(org, list.id, ...group),
      d1.prepare(`SELECT email FROM mail_subscribers WHERE org_id = ?1 AND email IN (${marks.replace(/\?(\d+)/g, (_m, n: string) => `?${Number(n) - 1}`)})`).bind(org, ...group),
    );
  }
  const suppressed = new Set<string>();
  const active = new Set<string>();
  const known = new Set<string>();
  if (reads.length) {
    const results = await d1.batch<{ email: string }>(reads);
    results.forEach((r, i) => {
      const target = [suppressed, active, known][i % 3]!;
      for (const row of r.results) target.add(row.email);
    });
  }

  const note = `Imported on ${new Date(now).toISOString().slice(0, 10)}; importer confirmed these people agreed to get email`;
  const writes: D1PreparedStatement[] = [];
  for (const row of rows.values()) {
    if (suppressed.has(row.email)) {
      report.suppressed++;
      continue;
    }
    if (active.has(row.email)) report.already_subscribed++;
    else if (!known.has(row.email)) report.added++;
    writes.push(
      d1
        .prepare(
          `INSERT INTO mail_subscribers (id, org_id, email, name, fields, source, consent_note, consent_at, created_at, updated_at)
           VALUES (?1, ?2, ?3, ?4, ?5, 'import', ?6, ?7, ?7, ?7)
           ON CONFLICT (org_id, email) DO UPDATE SET
             name = CASE WHEN mail_subscribers.name = '' THEN excluded.name ELSE mail_subscribers.name END,
             fields = json_patch(mail_subscribers.fields, excluded.fields), updated_at = excluded.updated_at`,
        )
        .bind(newId('msb', now), org, row.email, row.name, JSON.stringify(row.fields), note, now),
      d1
        .prepare(
          `INSERT INTO mail_memberships (org_id, list_id, subscriber_id, status, joined_at, confirmed_at)
           SELECT ?1, ?2, id, 'active', ?4, ?4 FROM mail_subscribers WHERE org_id = ?1 AND email = ?3
           ON CONFLICT (org_id, list_id, subscriber_id) DO UPDATE SET status = 'active', confirmed_at = ?4 WHERE mail_memberships.status = 'pending'`,
        )
        .bind(org, list.id, row.email, now),
      ...row.tags.map((tag) =>
        d1
          .prepare('INSERT OR IGNORE INTO mail_subscriber_tags (org_id, subscriber_id, tag) SELECT ?1, id, ?3 FROM mail_subscribers WHERE org_id = ?1 AND email = ?2')
          .bind(org, row.email, tag),
      ),
    );
  }
  for (const group of chunks(writes, 100)) await d1.batch(group);
  if (report.added > 0) {
    await emit(ctx.env, { orgId: org, module: 'mail', name: 'subscriber.created', data: { imported: report.added, list: list.slug }, count: report.added, at: now });
  }
  return report;
}

// -- export ---------------------------------------------------------------------------------------

export const EXPORT_MAX = 10_000;

export async function exportSubscribersCsv(ctx: Ctx, opts: { listId?: string; segment?: Filter } = {}): Promise<string> {
  const fields = await listFields(ctx);
  const rows: Record<string, unknown>[] = [];
  for (let offset = 0; offset < EXPORT_MAX; offset += 200) {
    const { items } = await querySubscribers(ctx, { ...(opts.listId ? { listId: opts.listId } : {}), segment: opts.segment ?? EMPTY_FILTER, limit: 200, offset });
    for (const s of items) {
      const f = fieldsOf(s);
      rows.push({
        email: s.email,
        name: s.name,
        status: s.status ?? '',
        tags: (s.tags ?? '').split(',').filter(Boolean).join(';'),
        source: s.source,
        joined: new Date(s.created_at).toISOString(),
        ...Object.fromEntries(fields.map((d) => [d.key, f[d.key] ?? ''])),
      });
    }
    if (items.length < 200) break;
  }
  return toCsv(rows, { bom: true, columns: ['email', 'name', 'status', 'tags', 'source', 'joined', ...fields.map((d) => d.key)] });
}
