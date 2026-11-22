/**
 * Every email the waitlist sends. Each builder returns subject, HTML and text; `deliver` sends through
 * the core email service. Marketing-type emails (welcome, milestone, invite, broadcast) carry an
 * unsubscribe link made with a signed token.
 */
import { emailStatus, sendEmail, type EmailStatus } from '../../core/email';
import { cleanSubject } from '../../core/email-templates';
import { resolveBrand } from '../../core/email-templates/brand';
import type { Env } from '../../env';
import { makeToken } from './platform';
import type { Signup, Tier, Waitlist } from './types';

export interface Built {
  subject: string;
  html: string;
  text: string;
}

interface Parts {
  subject: string;
  heading: string;
  paragraphs: string[];
  button?: { label: string; href: string };
  small?: string[];
  footer?: string;
}

function esc(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

async function layout(env: Env, orgId: string, parts: Parts): Promise<Built> {
  const brand = await resolveBrand(env, orgId);
  const paragraphs = parts.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#4a4a46;">${esc(p)}</p>`).join('');
  const button = parts.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td bgcolor="${brand.accent}" style="border-radius:8px;background:${brand.accent};"><a href="${esc(parts.button.href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${esc(parts.button.label)}</a></td></tr></table><p style="margin:0 0 14px;font-size:12px;line-height:18px;color:#8a8a85;word-break:break-all;">${esc(parts.button.href)}</p>`
    : '';
  const small = (parts.small ?? []).map((s) => `<p style="margin:0 0 8px;font-size:12px;line-height:18px;color:#8a8a85;">${esc(s)}</p>`).join('');
  const foot = [`Sent by ${brand.name}.`, brand.footer].filter(Boolean).join(' ');
  const unsub = parts.footer ? `<p style="margin:0;font-size:12px;line-height:18px;color:#8a8a85;"><a href="${esc(parts.footer)}" style="color:#6b6b66;">Unsubscribe</a></p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(parts.subject)}</title></head><body style="margin:0;padding:0;background:#f4f4f1;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f1;"><tr><td align="center" style="padding:28px 12px;"><table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;"><tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${brand.accent};padding:28px 28px 22px;font-family:${FONT};"><div style="margin:0 0 18px;font-size:16px;font-weight:600;color:#1d1d1b;">${esc(brand.name)}</div><h1 style="margin:0 0 12px;font-size:20px;line-height:26px;font-weight:600;color:#1d1d1b;">${esc(parts.heading)}</h1>${paragraphs}${button}${small}</td></tr><tr><td style="padding:14px 8px 0;text-align:center;font-family:${FONT};"><p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#8a8a85;">${esc(foot)}</p>${unsub}</td></tr></table></td></tr></table></body></html>`;
  const text = [parts.heading, '', ...parts.paragraphs.flatMap((p) => [p, '']), ...(parts.button ? [`${parts.button.label}: ${parts.button.href}`, ''] : []), ...(parts.small ?? []), '', '--', foot, ...(parts.footer ? [`Unsubscribe: ${parts.footer}`] : [])]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
  return { subject: cleanSubject(parts.subject), html, text: `${text}\n` };
}

/** The link back to a person's own status page. The token, not the email, identifies them. */
export const statusLink = (base: string, wl: Pick<Waitlist, 'slug'>, s: Pick<Signup, 'token'>) => `${base}/w/${wl.slug}/me/${s.token}`;
export const confirmLink = (base: string, wl: Pick<Waitlist, 'slug'>, s: Pick<Signup, 'token'>) => `${base}/w/${wl.slug}/confirm/${s.token}`;
export const referralLink = (base: string, wl: Pick<Waitlist, 'slug'>, s: Pick<Signup, 'code'>) => `${base}/w/${wl.slug}?ref=${s.code}`;
export const inviteLink = (base: string, wl: Pick<Waitlist, 'slug'>, code: string) => `${base}/w/${wl.slug}/invite/${code}`;

async function unsubscribeLink(env: Env, base: string, s: Signup): Promise<string> {
  return `${base}/w/unsubscribe/${await makeToken(env, 'wl-unsub', { s: s.id }, 400 * 86_400)}`;
}

export function confirmEmail(env: Env, base: string, wl: Waitlist, s: Signup): Promise<Built> {
  return layout(env, wl.org_id, {
    subject: `Confirm your spot on ${wl.name}`,
    heading: 'Confirm your email',
    paragraphs: [`You asked to join ${wl.name}. Confirm your email to hold your place in line.`],
    button: { label: 'Confirm my spot', href: confirmLink(base, wl, s) },
    small: ['If you did not sign up, ignore this email and nothing happens.'],
  });
}

export async function welcomeEmail(env: Env, base: string, wl: Waitlist, s: Signup, position: number | null): Promise<Built> {
  return layout(env, wl.org_id, {
    subject: `You are on the ${wl.name} waitlist`,
    heading: position ? `You are number ${position}` : 'You are on the list',
    paragraphs: [
      `Thanks for joining ${wl.name}.${wl.skip_per_referral > 0 ? ` Every friend who joins and confirms with your link moves you up ${wl.skip_per_referral} places.` : ''}`,
      `Your personal link: ${referralLink(base, wl, s)}`,
    ],
    button: { label: 'See my place in line', href: statusLink(base, wl, s) },
    footer: await unsubscribeLink(env, base, s),
  });
}

export async function milestoneEmail(env: Env, base: string, wl: Waitlist, s: Signup, tier: Tier): Promise<Built> {
  return layout(env, wl.org_id, {
    subject: `You unlocked ${tier.name}`,
    heading: `You unlocked ${tier.name}`,
    paragraphs: [`${s.referral_count} friends have joined ${wl.name} with your link.`, tier.reward_text || 'Thank you for spreading the word.'],
    button: { label: 'See my progress', href: statusLink(base, wl, s) },
    footer: await unsubscribeLink(env, base, s),
  });
}

export function statusEmail(env: Env, base: string, wl: Waitlist, s: Signup): Promise<Built> {
  return layout(env, wl.org_id, {
    subject: `Your place on ${wl.name}`,
    heading: 'Your link to your place in line',
    paragraphs: ['You asked for a link to your waitlist page. It shows your position and your referral link.'],
    button: { label: 'Open my page', href: statusLink(base, wl, s) },
    small: ['If you did not ask for this, ignore it. Only the owner of this inbox gets the link.'],
  });
}

const TOKENS = /\{\{\s*(name|email|referral_link|position|invite_link)\s*\}\}/g;

/** Fill `{{name}}`, `{{referral_link}}`, `{{position}}` and `{{invite_link}}` in an owner-written message. */
export function fillTokens(text: string, values: Record<string, string>): string {
  return text.replace(TOKENS, (_m, key: string) => values[key] ?? '');
}

export async function customEmail(
  env: Env,
  base: string,
  wl: Waitlist,
  s: Signup,
  content: { subject: string; body: string; inviteCode?: string | null },
  position: number | null,
): Promise<Built> {
  const values: Record<string, string> = {
    name: s.name || 'there',
    email: s.email,
    referral_link: referralLink(base, wl, s),
    position: position ? String(position) : '',
    invite_link: content.inviteCode ? inviteLink(base, wl, content.inviteCode) : '',
  };
  const paragraphs = fillTokens(content.body, values).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  return layout(env, wl.org_id, {
    subject: fillTokens(content.subject, values),
    heading: fillTokens(content.subject, values),
    paragraphs,
    button: content.inviteCode ? { label: 'Claim your invite', href: inviteLink(base, wl, content.inviteCode) } : undefined,
    footer: await unsubscribeLink(env, base, s),
  });
}

/** Can this install send email at all (a live sender, or the dev outbox)? */
export async function canSendEmail(env: Env): Promise<boolean> {
  return (await emailStatus(env)).status === 'ready';
}

export async function deliver(env: Env, orgId: string, to: string, built: Built, tag: string): Promise<EmailStatus> {
  const res = await sendEmail(env, { orgId, to, subject: built.subject, html: built.html, text: built.text, template: `waitlist.${tag}`, tag: `waitlist.${tag}` });
  return res.status;
}
