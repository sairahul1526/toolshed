/** The emails Mail writes itself: the signup confirmation and the unsubscribe headers. */
import { resolveBrand } from '../../core/email-templates/brand';
import type { Env } from '../../env';
import type { Brand } from '../../core/email-templates/types';
import { buttonHtml, layoutHtml, layoutText } from './layout';
import { escapeHtml, valuesFor } from './merge';
import { renderMail, type Content } from './render';
import { getMailSettings } from './settings';
import type { Outgoing, Sender, SendResult } from './sender';
import { clickToken, confirmToken, openToken, unsubscribeToken } from './tokens';
import type { List, Subscriber } from './types';

export const unsubscribeUrl = async (env: Env, base: string, t: { o: string; s: string; l: string }, broadcastId = ''): Promise<string> =>
  `${base}/n/u/${await unsubscribeToken(env, t, broadcastId)}`;

/** One-click unsubscribe headers (RFC 8058). The POST target is the same address as the link. */
export function unsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/**
 * The confirmation email. Plain on purpose: one sentence, one button, no marketing, no tracking.
 * It never carries an unsubscribe link because nothing has been subscribed yet.
 */
export async function sendConfirmEmail(env: Env, sender: Sender, list: List, sub: Pick<Subscriber, 'id' | 'email'>, base: string): Promise<SendResult> {
  const [brand, settings] = await Promise.all([resolveBrand(env, list.org_id), getMailSettings(env, list.org_id)]);
  const url = `${base}/n/confirm/${await confirmToken(env, { o: list.org_id, s: sub.id, l: list.id })}`;
  const subject = `Confirm your subscription to ${list.name}`;
  const footer = { listName: list.name, postalAddress: settings.postalAddress, unsubscribeUrl: '', confirm: true };
  const content = `<p>Please confirm that you want to get emails from <strong>${escapeHtml(list.name)}</strong>.</p>${buttonHtml('Confirm my subscription', url, brand.accent)}<p style="color:#6b7280;font-size:14px">If you didn’t ask for this, ignore this email and nothing will happen.</p>`;
  const message: Outgoing = {
    orgId: list.org_id,
    to: sub.email,
    subject,
    html: layoutHtml({ brand, subject, preheader: '', content, footer }),
    text: layoutText({ content: `Please confirm that you want to get emails from ${list.name}.\n\nConfirm: ${url}\n\nIf you didn’t ask for this, ignore this email and nothing will happen.`, footer }),
    tag: 'mail.confirm',
    template: `mail:confirm:${list.id}`,
    ...(list.reply_to ? { replyTo: list.reply_to } : {}),
  };
  return sender.send(message);
}

export interface ComposeInput {
  env: Env;
  list: List;
  sub: Pick<Subscriber, 'id' | 'email' | 'name' | 'fields'>;
  content: Content;
  kind: 'mail.broadcast' | 'mail.sequence' | 'mail.test';
  /** A broadcast id, or `seq:<step id>` for welcome emails. Used for the unsubscribe token and the delivery log. */
  scope: string;
  base: string;
  brand: Brand;
  postalAddress: string;
  /** Link ids by destination, from the broadcast's link table. Empty means clicks are not tracked. */
  links?: Map<string, string>;
  deliveryId?: string;
  trackOpens?: boolean;
  viewUrl?: string;
  /** No real person: links show a placeholder and the unsubscribe link is left out. */
  preview?: boolean;
}

/** Build the finished message for one person: merge, render, footer, tracking, one-click unsubscribe headers. */
export async function composeMessage(i: ComposeInput): Promise<Outgoing> {
  const unsub = i.preview ? '' : await unsubscribeUrl(i.env, i.base, { o: i.list.org_id, s: i.sub.id, l: i.list.id }, i.scope);
  let fields: Record<string, string> = {};
  try {
    fields = JSON.parse(i.sub.fields || '{}') as Record<string, string>;
  } catch {
    fields = {};
  }
  const values = valuesFor({ email: i.sub.email, name: i.sub.name, fields }, { list_name: i.list.name, unsubscribe_url: unsub || '#', preferences_url: unsub || '#' });
  const tokens = new Map<string, string>();
  if (i.links?.size && i.deliveryId) {
    for (const [url, id] of i.links) tokens.set(url, await clickToken(i.env, { o: i.list.org_id, k: id, d: i.deliveryId }));
  }
  const pixel = i.trackOpens && i.deliveryId ? `${i.base}/n/o/${await openToken(i.env, { o: i.list.org_id, d: i.deliveryId })}` : undefined;
  const rendered = renderMail(i.content, {
    brand: i.brand,
    values,
    footer: {
      listName: i.list.name,
      postalAddress: i.postalAddress,
      unsubscribeUrl: unsub,
      ...(i.viewUrl ? { viewUrl: i.viewUrl } : {}),
      ...(pixel || tokens.size ? { tracked: `This email counts ${pixel && tokens.size ? 'opens and clicks' : pixel ? 'opens' : 'clicks'}, so the sender can see what people read.` } : {}),
    },
    ...(tokens.size ? { rewriteLink: (u: string) => (tokens.has(u) ? `${i.base}/n/c/${tokens.get(u)}` : u) } : {}),
    ...(pixel ? { pixelUrl: pixel } : {}),
  });
  return {
    orgId: i.list.org_id,
    to: i.sub.email,
    subject: i.kind === 'mail.test' ? `[Test] ${rendered.subject}` : rendered.subject,
    html: rendered.html,
    text: rendered.text,
    tag: i.kind,
    template: `mail:${i.scope}`,
    ...(i.list.reply_to ? { replyTo: i.list.reply_to } : {}),
    ...(unsub ? { headers: unsubscribeHeaders(unsub) } : {}),
  };
}
