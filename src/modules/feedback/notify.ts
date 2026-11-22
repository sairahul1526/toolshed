/**
 * Close-the-loop email. Every notice is one row in fb_outbox, worked off by the `feedback.notify`
 * job in batches of ten people. The row keeps a cursor and every send is recorded in fb_deliveries,
 * so a job that dies halfway resumes where it stopped and nobody gets the same email twice.
 *
 * No open or click tracking: links go straight to the page. Every message carries an unsubscribe link.
 * When the install's hourly email caps are hit, the job waits and tries again instead of dropping people.
 */
import { newId, parseJson } from '../../core/db';
import { emailStatus, sendEmail } from '../../core/email';
import { enqueue } from '../../core/jobs';
import type { Env } from '../../env';
import { renderMail } from './emails';
import { readSignedToken, signedToken } from './lib';
import { excerpt, markdownToText } from './lib';
import type { Portal } from './types';

export const BATCH = 10;
export const CAP_WAIT_SECONDS = 900;

export type NoticeKind = 'status' | 'reply' | 'declined' | 'shipped' | 'entry' | 'digest';

export interface NoticeInput {
  kind: NoticeKind;
  postId?: string;
  entryId?: string;
  payload?: Record<string, unknown>;
  origin?: string;
}

interface OutboxRow {
  id: string;
  org_id: string;
  kind: NoticeKind;
  post_id: string | null;
  entry_id: string | null;
  payload: string;
  cursor: string;
  state: string;
  sent: number;
  skipped: number;
}

export function originOf(env: Env, origin?: string): string {
  return (env.APP_URL || origin || '').replace(/\/$/, '');
}

/** Record a notice and start the job that sends it. Nothing is sent inline. */
export async function queueNotice(env: Env, orgId: string, input: NoticeInput): Promise<string> {
  const id = newId('fbo');
  const payload = { ...(input.payload ?? {}), origin: originOf(env, input.origin) };
  await env.DB.prepare(
    `INSERT INTO fb_outbox (id, org_id, kind, post_id, entry_id, payload, cursor, state, sent, skipped, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, '', 'pending', 0, 0, ?7)`,
  )
    .bind(id, orgId, input.kind, input.postId ?? null, input.entryId ?? null, JSON.stringify(payload), Date.now())
    .run();
  await enqueue(env, 'feedback.notify', { orgId, outboxId: id });
  return id;
}

interface Recipient {
  id: string;
  email: string;
}

async function nextRecipients(env: Env, row: OutboxRow, payload: Record<string, unknown>): Promise<Recipient[]> {
  if (row.kind === 'entry' || row.kind === 'digest') {
    const freq = row.kind === 'entry' ? 'each' : String(payload.frequency ?? 'weekly');
    const { results } = await env.DB.prepare(
      `SELECT id, email FROM fb_subscribers WHERE org_id = ?1 AND status = 'active' AND frequency = ?2 AND id > ?3 ORDER BY id LIMIT ?4`,
    )
      .bind(row.org_id, freq, row.cursor, BATCH)
      .all<Recipient>();
    return results;
  }
  const { results } = await env.DB.prepare(
    `SELECT pe.id AS id, pe.email AS email FROM fb_people pe
      WHERE pe.org_id = ?1 AND pe.email IS NOT NULL AND pe.mail_off = 0 AND pe.blocked = 0 AND pe.verified = 1 AND pe.id > ?2
        AND (pe.id = (SELECT author_id FROM fb_posts WHERE id = ?3) OR pe.id IN (SELECT person_id FROM fb_votes WHERE post_id = ?3))
      ORDER BY pe.id LIMIT ?4`,
  )
    .bind(row.org_id, row.cursor, row.post_id, BATCH)
    .all<Recipient>();
  return results;
}

async function portalFor(env: Env, orgId: string): Promise<Portal | null> {
  return env.DB.prepare('SELECT * FROM fb_portals WHERE org_id = ?1').bind(orgId).first<Portal>();
}

export async function personUnsubUrl(env: Env, origin: string, portal: Portal, personId: string): Promise<string> {
  const t = await signedToken(env, 'feedback-unsub', { o: portal.org_id, p: personId }, 3650 * 24 * 3600);
  return `${origin}/feedback/${portal.slug}/unsubscribe?t=${t}`;
}

export async function subscriberUnsubUrl(env: Env, origin: string, portal: Portal, subscriberId: string): Promise<string> {
  const t = await signedToken(env, 'feedback-sub', { o: portal.org_id, s: subscriberId, a: 'unsub' }, 3650 * 24 * 3600);
  return `${origin}/changelog/${portal.slug}/unsubscribe?t=${t}`;
}

export async function readSubscriberToken(env: Env, token: string): Promise<{ o: string; s: string; a: string } | null> {
  return readSignedToken<{ o: string; s: string; a: string }>(env, 'feedback-sub', token);
}

export async function adminUnsubUrl(env: Env, origin: string, portal: Portal, email: string): Promise<string> {
  const t = await signedToken(env, 'feedback-admin-unsub', { o: portal.org_id, e: email }, 3650 * 24 * 3600);
  return `${origin}/feedback/${portal.slug}/unsubscribe?a=${t}`;
}

export async function readAdminUnsubToken(env: Env, token: string): Promise<{ o: string; e: string } | null> {
  return readSignedToken<{ o: string; e: string }>(env, 'feedback-admin-unsub', token);
}

interface PostLite {
  title: string;
  slug: string;
  board_slug: string;
  status_name: string | null;
  decline_reason: string | null;
}

async function loadPost(env: Env, orgId: string, id: string): Promise<PostLite | null> {
  return env.DB.prepare(
    `SELECT p.title, p.slug, b.slug AS board_slug, s.name AS status_name, p.decline_reason
       FROM fb_posts p JOIN fb_boards b ON b.id = p.board_id LEFT JOIN fb_statuses s ON s.id = p.status_id
      WHERE p.org_id = ?1 AND p.id = ?2`,
  )
    .bind(orgId, id)
    .first<PostLite>();
}

export function postUrl(origin: string, portal: Portal, post: { slug: string }): string {
  return `${origin}/feedback/${portal.slug}/p/${post.slug}`;
}

async function buildMail(env: Env, row: OutboxRow, portal: Portal, payload: Record<string, unknown>, to: Recipient) {
  const origin = String(payload.origin ?? '');
  const isSub = row.kind === 'entry' || row.kind === 'digest';
  const unsubscribe = {
    href: isSub ? await subscriberUnsubUrl(env, origin, portal, to.id) : await personUnsubUrl(env, origin, portal, to.id),
    label: isSub ? 'Unsubscribe from changelog emails' : 'Stop emails about posts you follow',
  };
  if (row.kind === 'entry') {
    return renderMail(env, row.org_id, {
      subject: `${portal.name}: ${String(payload.title ?? 'New update')}`,
      heading: String(payload.title ?? 'New update'),
      paragraphs: [String(payload.excerpt ?? '')].filter(Boolean),
      button: { label: 'Read the update', href: `${origin}/changelog/${portal.slug}/${String(payload.slug ?? '')}` },
      unsubscribe,
    });
  }
  if (row.kind === 'digest') {
    const entries = (payload.entries as { title: string; slug: string; excerpt: string }[]) ?? [];
    return renderMail(env, row.org_id, {
      subject: `${portal.name}: what's new ${payload.frequency === 'monthly' ? 'this month' : 'this week'}`,
      heading: `What's new at ${portal.name}`,
      paragraphs: entries.flatMap((e) => [`${e.title}. ${e.excerpt}`]),
      button: { label: 'See all updates', href: `${origin}/changelog/${portal.slug}` },
      unsubscribe,
    });
  }
  const post = row.post_id ? await loadPost(env, row.org_id, row.post_id) : null;
  if (!post) return null;
  const href = postUrl(origin, portal, post);
  if (row.kind === 'status') {
    return renderMail(env, row.org_id, {
      subject: `${post.title}: now ${String(payload.status ?? post.status_name ?? 'updated')}`,
      heading: `Status changed to ${String(payload.status ?? post.status_name ?? 'updated')}`,
      paragraphs: [`You follow "${post.title}" on ${portal.name}. Its status just changed.`],
      button: { label: 'View the post', href },
      unsubscribe,
    });
  }
  if (row.kind === 'declined') {
    return renderMail(env, row.org_id, {
      subject: `${post.title}: we won't build this`,
      heading: 'We decided not to build this',
      paragraphs: [`You follow "${post.title}" on ${portal.name}.`, String(payload.reason ?? post.decline_reason ?? 'The team closed this request.')],
      button: { label: 'View the post', href },
      unsubscribe,
    });
  }
  if (row.kind === 'shipped') {
    return renderMail(env, row.org_id, {
      subject: `Shipped: ${post.title}`,
      heading: 'It shipped',
      paragraphs: [`"${post.title}" is live.${payload.entryTitle ? ` Read the update: ${String(payload.entryTitle)}.` : ''}`],
      button: { label: 'See what changed', href: payload.entrySlug ? `${origin}/changelog/${portal.slug}/${String(payload.entrySlug)}` : href },
      unsubscribe,
    });
  }
  return renderMail(env, row.org_id, {
    subject: `${String(payload.who ?? 'The team')} replied to ${post.title}`,
    heading: `${String(payload.who ?? 'The team')} replied`,
    paragraphs: [String(payload.excerpt ?? '')].filter(Boolean),
    button: { label: 'Read the reply', href },
    unsubscribe,
  });
}

/** Work one batch of a notice. Re-queues itself until everyone is done. */
export async function runNotice(env: Env, orgId: string, outboxId: string): Promise<void> {
  const row = await env.DB.prepare('SELECT * FROM fb_outbox WHERE org_id = ?1 AND id = ?2').bind(orgId, outboxId).first<OutboxRow>();
  if (!row || row.state === 'done') return;
  const portal = await portalFor(env, orgId);
  if (!portal) return finish(env, row, 'done');
  const status = await emailStatus(env);
  if (status.status !== 'ready') return finish(env, row, 'skipped');
  const payload = parseJson<Record<string, unknown>>(row.payload, {});
  const people = await nextRecipients(env, row, payload);
  let sent = 0;
  let skipped = 0;
  let cursor = row.cursor;
  let capped = false;
  for (const to of people) {
    const seen = await env.DB.prepare('SELECT status FROM fb_deliveries WHERE outbox_id = ?1 AND to_key = ?2').bind(row.id, to.id).first<{ status: string }>();
    if (seen) {
      cursor = to.id;
      continue;
    }
    const mail = await buildMail(env, row, portal, payload, to);
    if (!mail) {
      cursor = to.id;
      skipped++;
      continue;
    }
    const result = await sendEmail(env, { orgId, to: to.email, subject: mail.subject, html: mail.html, text: mail.text, template: `feedback-${row.kind}`, tag: 'feedback', replyTo: portal.reply_to ?? undefined });
    if (result.status === 'capped') {
      capped = true;
      break;
    }
    const ok = result.status === 'sent' || result.status === 'dev';
    await env.DB.prepare('INSERT OR IGNORE INTO fb_deliveries (outbox_id, org_id, to_key, status, at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(row.id, orgId, to.id, ok ? 'sent' : result.status, Date.now()).run();
    if (ok) sent++;
    else skipped++;
    cursor = to.id;
  }
  const more = capped || people.length >= BATCH;
  await env.DB.prepare('UPDATE fb_outbox SET cursor = ?3, sent = sent + ?4, skipped = skipped + ?5, state = ?6, finished_at = ?7 WHERE org_id = ?1 AND id = ?2')
    .bind(orgId, row.id, cursor, sent, skipped, more ? 'sending' : 'done', more ? null : Date.now())
    .run();
  if (more) await enqueue(env, 'feedback.notify', { orgId, outboxId: row.id }, { delaySeconds: capped ? CAP_WAIT_SECONDS : 1 });
}

async function finish(env: Env, row: OutboxRow, state: string): Promise<void> {
  await env.DB.prepare('UPDATE fb_outbox SET state = ?3, finished_at = ?4 WHERE org_id = ?1 AND id = ?2').bind(row.org_id, row.id, state, Date.now()).run();
}

export async function listOutbox(env: Env, orgId: string, limit = 20): Promise<OutboxRow[]> {
  const { results } = await env.DB.prepare('SELECT * FROM fb_outbox WHERE org_id = ?1 ORDER BY created_at DESC LIMIT ?2').bind(orgId, limit).all<OutboxRow>();
  return results;
}

/** Plain text for an email: strip Markdown and cut short. */
export function mailExcerpt(body: string, max = 280): string {
  return excerpt(markdownToText(body), max);
}

