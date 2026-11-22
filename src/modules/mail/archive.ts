/** The public archive: past issues of a newsletter, as web pages and an RSS feed. Off unless the newsletter and the issue both opt in. */
import { resolveBrand } from '../../core/email-templates/brand';
import { excerpt } from '../../core/markdown';
import type { Env } from '../../env';
import { escapeHtml, mergeText } from './merge';
import { htmlToText, renderBodyHtml } from './render';
import type { Broadcast, Ctx, List } from './types';

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'issue';

/** A web address for an issue. Set once, when the issue starts to send, so links in emails never change. */
export async function ensureArchiveSlug(ctx: Ctx, b: Broadcast): Promise<string> {
  if (b.archive_slug) return b.archive_slug;
  const base = slugify(b.subject);
  let slug = base;
  for (let n = 2; n < 50; n++) {
    const taken = await ctx.db.first('SELECT 1 AS x FROM mail_broadcasts WHERE org_id = :org AND list_id = ? AND archive_slug = ?', b.list_id, slug);
    if (!taken) break;
    slug = `${base}-${n}`;
  }
  await ctx.db.run('UPDATE mail_broadcasts SET archive_slug = ? WHERE org_id = :org AND id = ?', slug, b.id);
  return slug;
}

export interface ArchiveIssue {
  slug: string;
  subject: string;
  sent_at: number;
  summary: string;
}

export const archivePage = async (env: Env, list: List, limit = 50, offset = 0): Promise<ArchiveIssue[]> => {
  const rows = await env.DB.prepare(
    `SELECT archive_slug, subject, preheader, body, format, COALESCE(finished_at, started_at, created_at) AS at FROM mail_broadcasts
     WHERE org_id = ?1 AND list_id = ?2 AND in_archive = 1 AND status = 'sent' AND archive_slug <> '' ORDER BY at DESC LIMIT ?3 OFFSET ?4`,
  )
    .bind(list.org_id, list.id, limit, offset)
    .all<{ archive_slug: string; subject: string; preheader: string; body: string; format: string; at: number }>();
  return rows.results.map((r) => ({
    slug: r.archive_slug,
    subject: mergeText(r.subject, { list_name: list.name }),
    sent_at: r.at,
    summary: r.preheader || excerpt(r.format === 'html' ? htmlToText(r.body) : r.body, 160),
  }));
};

export async function archiveIssue(env: Env, list: List, slug: string): Promise<{ subject: string; html: string; sent_at: number } | null> {
  const b = await env.DB.prepare("SELECT * FROM mail_broadcasts WHERE org_id = ?1 AND list_id = ?2 AND archive_slug = ?3 AND in_archive = 1 AND status = 'sent'")
    .bind(list.org_id, list.id, slug)
    .first<Broadcast>();
  if (!b) return null;
  const brand = await resolveBrand(env, list.org_id);
  const values = { list_name: list.name, unsubscribe_url: '', preferences_url: '' };
  return { subject: mergeText(b.subject, values), html: renderBodyHtml(b, brand, values), sent_at: b.finished_at ?? b.started_at ?? b.created_at };
}

export function archiveRss(list: List, issues: ArchiveIssue[], base: string): string {
  const root = `${base}/n/${list.slug}`;
  const items = issues
    .map(
      (i) =>
        `<item><title>${escapeHtml(i.subject)}</title><link>${root}/archive/${i.slug}</link><guid isPermaLink="true">${root}/archive/${i.slug}</guid><pubDate>${new Date(i.sent_at).toUTCString()}</pubDate><description>${escapeHtml(i.summary)}</description></item>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${escapeHtml(list.name)}</title><link>${root}/archive</link><description>${escapeHtml(list.description || `Past issues of ${list.name}`)}</description>${items}</channel></rss>`;
}
