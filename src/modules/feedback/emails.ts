/**
 * Email layout for Feedback. Plain, no tracking pixels, no click redirects, and every message
 * that is not a sign-in code carries an unsubscribe link.
 */
import { resolveBrand } from '../../core/email-templates/brand';
import type { Env } from '../../env';
import { esc } from './util';

export interface MailContent {
  subject: string;
  preheader?: string;
  heading: string;
  paragraphs: string[];
  code?: string;
  button?: { label: string; href: string };
  small?: string[];
  unsubscribe?: { href: string; label: string };
}

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

function safeHref(href: string): string {
  return /^https?:\/\//i.test(href) ? href : '#';
}

export async function renderMail(env: Env, orgId: string, c: MailContent): Promise<{ subject: string; html: string; text: string }> {
  const brand = await resolveBrand(env, orgId);
  const subject = c.subject.replace(/[\r\n]+/g, ' ').slice(0, 150);
  const paras = c.paragraphs.map((p) => `<p style="margin:0 0 14px;font-size:15px;line-height:22px;color:#2b2b28;">${esc(p)}</p>`).join('');
  const code = c.code
    ? `<p style="margin:6px 0 18px;font-size:30px;letter-spacing:6px;font-weight:600;font-family:ui-monospace,Menlo,Consolas,monospace;color:#1d1d1b;">${esc(c.code)}</p>`
    : '';
  const button = c.button
    ? `<p style="margin:8px 0 18px;"><a href="${esc(safeHref(c.button.href))}" style="display:inline-block;background:${brand.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:10px 18px;border-radius:8px;">${esc(c.button.label)}</a></p>`
    : '';
  const small = (c.small ?? []).map((s) => `<p style="margin:0 0 8px;font-size:13px;line-height:19px;color:#6b6b66;">${esc(s)}</p>`).join('');
  const unsub = c.unsubscribe
    ? `<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#8a8a85;"><a href="${esc(safeHref(c.unsubscribe.href))}" style="color:#8a8a85;">${esc(c.unsubscribe.label)}</a></p>`
    : '';
  const footer = brand.footer ? `<p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#8a8a85;">${esc(brand.footer)}</p>` : '';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;background:#f4f4f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(c.preheader ?? '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f4f4f1;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="520" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:520px;">
<tr><td style="background:#ffffff;border-radius:12px;border-top:4px solid ${brand.accent};padding:28px 28px 22px;font-family:${FONT};">
<p style="margin:0 0 18px;font-size:14px;font-weight:600;color:#1d1d1b;">${esc(brand.name)}</p>
<h1 style="margin:0 0 14px;font-size:20px;line-height:26px;font-weight:600;color:#1d1d1b;">${esc(c.heading)}</h1>
${paras}${code}${button}${small}
</td></tr>
<tr><td style="padding:14px 8px 0;text-align:center;font-family:${FONT};">${footer}${unsub}</td></tr>
</table></td></tr></table></body></html>`;
  const lines: string[] = [brand.name, '', c.heading, '', ...c.paragraphs.flatMap((p) => [p, ''])];
  if (c.code) lines.push(`    ${c.code}`, '');
  if (c.button) lines.push(`${c.button.label}: ${c.button.href}`, '');
  for (const s of c.small ?? []) lines.push(s);
  if (brand.footer) lines.push('', brand.footer);
  if (c.unsubscribe) lines.push('', `${c.unsubscribe.label}: ${c.unsubscribe.href}`);
  return { subject, html, text: lines.join('\n').replace(/\n{3,}/g, '\n\n') + '\n' };
}
