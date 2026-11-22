/**
 * The two emails a form can send: a note to the team when a response arrives, and a thank-you to
 * the respondent. Each returns `{ subject, html, text }` and is sent by the caller with core
 * `sendEmail`. The layout is deliberately small and plain so it reads well everywhere.
 */
import { cleanSubject } from '../../core/email-templates';
import type { Brand } from '../../core/email-templates/types';

export interface RenderedMail {
  subject: string;
  html: string;
  text: string;
}

export interface AnswerLine {
  label: string;
  value: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function onAccent(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

function layout(brand: Brand, heading: string, body: string, button?: { label: string; href: string }, note?: string): string {
  const logo = brand.logoUrl ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="28" style="display:block;height:28px;margin:0 0 20px">` : `<p style="margin:0 0 20px;font-weight:600;font-size:15px">${esc(brand.name)}</p>`;
  const btn = button ? `<p style="margin:24px 0 0"><a href="${esc(button.href)}" style="display:inline-block;background:${brand.accent};color:${onAccent(brand.accent)};padding:10px 18px;border-radius:6px;text-decoration:none;font-weight:600;font-size:14px">${esc(button.label)}</a></p>` : '';
  const foot = [note, brand.footer].filter(Boolean).map((t) => `<p style="margin:12px 0 0;font-size:12px;color:#6b6b6b">${esc(t)}</p>`).join('');
  return `<!doctype html><html><body style="margin:0;background:#f5f5f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px"><table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:10px;border:1px solid #e5e5e3"><tr><td style="padding:28px">${logo}<h1 style="margin:0 0 14px;font-size:20px;line-height:1.3">${esc(heading)}</h1>${body}${btn}${foot}</td></tr></table></td></tr></table></body></html>`;
}

export interface TeamMailInput {
  brand: Brand;
  formName: string;
  lines: AnswerLine[];
  score: number | null;
  link: string;
  /** Answers longer than this are cut, with a pointer to the full response. */
  maxValue?: number;
}

export function teamNotification(input: TeamMailInput): RenderedMail {
  const cut = input.maxValue ?? 600;
  const lines = input.lines.filter((l) => l.value !== '').map((l) => ({ label: l.label, value: l.value.length > cut ? `${l.value.slice(0, cut)}…` : l.value }));
  const rows = lines.map((l) => `<tr><td style="padding:8px 0;border-top:1px solid #eeeeec;vertical-align:top"><div style="font-size:12px;color:#6b6b6b">${esc(l.label)}</div><div style="font-size:14px;white-space:pre-wrap">${esc(l.value)}</div></td></tr>`).join('');
  const score = input.score === null ? '' : `<p style="margin:12px 0 0;font-size:14px">Score: <strong>${esc(input.score)}</strong></p>`;
  const empty = lines.length === 0 ? '<p style="margin:0;font-size:14px;color:#6b6b6b">No questions were answered.</p>' : '';
  const html = layout(input.brand, `New response to ${input.formName}`, `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>${empty}${score}`, { label: 'Open the response', href: input.link }, 'You get this because you are on the notification list for this form. Turn it off in the form settings.');
  const text = [`New response to ${input.formName}`, '', ...lines.map((l) => `${l.label}\n${l.value}\n`), input.score === null ? '' : `Score: ${input.score}`, `Open the response: ${input.link}`].filter((x) => x !== '').join('\n');
  return { subject: cleanSubject(`New response: ${input.formName}`), html, text };
}

export interface AutoMailInput {
  brand: Brand;
  formName: string;
  subject: string;
  /** Plain text with line breaks. Already has the respondent's answers piped in. */
  body: string;
}

export function autoresponder(input: AutoMailInput): RenderedMail {
  const paras = input.body
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;white-space:pre-wrap">${esc(p)}</p>`)
    .join('');
  const html = layout(input.brand, input.subject, paras, undefined, `Sent because this address was entered on ${input.formName}. If that was not you, ignore this email.`);
  return { subject: cleanSubject(input.subject), html, text: `${input.body}\n\n---\nSent because this address was entered on ${input.formName}. If that was not you, ignore this email.` };
}
