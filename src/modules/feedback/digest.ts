/** Weekly "unanswered posts" email to the admins listed in the portal settings. */
import { sendEmail } from '../../core/email';
import { emailStatus } from '../../core/email';
import { originOf, adminUnsubUrl } from './notify';
import { renderMail } from './emails';
import { plural } from './util';
import type { Env } from '../../env';
import type { Portal } from './types';

export function adminList(portal: Portal): string[] {
  return portal.digest_emails
    .split(/[,\s;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.includes('@'));
}

export async function sendAdminDigest(env: Env, portal: Portal, now = Date.now()): Promise<{ sent: number; unanswered: number }> {
  const admins = adminList(portal);
  if (admins.length === 0 || (await emailStatus(env)).status !== 'ready') return { sent: 0, unanswered: 0 };
  const total = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM fb_posts p JOIN fb_statuses s ON s.id = p.status_id
      WHERE p.org_id = ?1 AND p.review = 'published' AND s.is_initial = 1 AND p.first_reply_at IS NULL AND p.created_at < ?2`,
  ).bind(portal.org_id, now - 24 * 3600 * 1000).first<{ n: number }>();
  const unanswered = total?.n ?? 0;
  if (unanswered === 0) return { sent: 0, unanswered };
  const { results } = await env.DB.prepare(
    `SELECT p.title, p.vote_count FROM fb_posts p JOIN fb_statuses s ON s.id = p.status_id
      WHERE p.org_id = ?1 AND p.review = 'published' AND s.is_initial = 1 AND p.first_reply_at IS NULL AND p.created_at < ?2
      ORDER BY p.vote_count DESC LIMIT 5`,
  ).bind(portal.org_id, now - 24 * 3600 * 1000).all<{ title: string; vote_count: number }>();
  const origin = originOf(env);
  let sent = 0;
  for (const email of admins) {
    const mail = await renderMail(env, portal.org_id, {
      subject: `${unanswered} ${plural(unanswered, 'post')} waiting for a reply`,
      heading: `${unanswered} ${plural(unanswered, 'post')} still waiting for a first reply`,
      paragraphs: ['The most voted ones:', ...results.map((r) => `${r.title} (${r.vote_count} ${plural(r.vote_count, 'vote')})`)],
      button: { label: 'Open the inbox', href: `${origin}/app/feedback` },
      unsubscribe: { href: await adminUnsubUrl(env, origin, portal, email), label: 'Stop these weekly emails' },
    });
    const r = await sendEmail(env, { orgId: portal.org_id, to: email, subject: mail.subject, html: mail.html, text: mail.text, template: 'feedback-admin-weekly', tag: 'feedback' });
    if (r.status === 'sent' || r.status === 'dev') sent++;
  }
  return { sent, unanswered };
}
