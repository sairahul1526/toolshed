/**
 * Renders every email Toolshed sends: one shared layout (tables and inline styles so Gmail, Outlook
 * and Apple Mail agree, light and dark friendly, no web fonts, no remote images except a logo the
 * workspace chose) plus a plain-text part that reads well on its own.
 *
 * Copy lives in `email-templates/<lang>.ts` as a typed dictionary. Add a language by adding a file
 * with the same shape and listing it in `DICTIONARIES`.
 */
import type { Env } from '../env';
import { errors } from './errors';
import { resolveBrand } from './email-templates/brand';
import { en } from './email-templates/en';
import { es } from './email-templates/es';
import type { Brand, Content, Messages, TemplateData, TemplateName } from './email-templates/types';
import { getSetting, INSTANCE } from './settings';

export { TEMPLATE_NAMES } from './email-templates/types';
export type { TemplateData, TemplateName } from './email-templates/types';

const DICTIONARIES: Record<string, Messages> = { en, es };
export const EMAIL_LANGUAGES = Object.keys(DICTIONARIES);

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** A subject is one line: line breaks would let a name inject headers. */
export function cleanSubject(subject: string): string {
  return subject.replace(/[\r\n\u0085\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function langOf(value: string | undefined | null): string | null {
  const base = (value ?? '').toLowerCase().split(/[-_]/)[0] ?? '';
  return base in DICTIONARIES ? base : null;
}

function safeHref(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.bad_request('An email link must be a full web address.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw errors.bad_request('An email link must start with https://.');
  return parsed.toString();
}

/** Black or white, whichever reads better on the accent color. */
function onAccent(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? '#111111' : '#ffffff';
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace";

function layoutHtml(content: Content, brand: Brand, common: Messages['common'], lang: string): string {
  const onBtn = onAccent(brand.accent);
  const head = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="${esc(brand.name)}" height="32" style="display:block;border:0;height:32px;max-width:200px;">`
    : `<span class="t" style="font-size:16px;font-weight:600;color:#1d1d1b;">${esc(brand.name)}</span>`;
  const paragraphs = content.paragraphs
    .map((p) => `<p class="m" style="margin:0 0 14px;font-size:15px;line-height:22px;color:#4a4a46;">${esc(p)}</p>`)
    .join('');
  const code = content.code
    ? `<div class="code" style="margin:6px 0 18px;padding:14px 8px;text-align:center;background:#f3f3ef;border-radius:8px;font-family:${MONO};font-size:32px;line-height:40px;letter-spacing:6px;font-weight:600;color:#1d1d1b;">${esc(content.code)}</div>`
    : '';
  const button = content.button
    ? `${content.buttonIntro ? `<p class="m" style="margin:0 0 12px;font-size:15px;line-height:22px;color:#4a4a46;">${esc(content.buttonIntro)}</p>` : ''}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 14px;"><tr><td bgcolor="${brand.accent}" style="border-radius:8px;background:${brand.accent};"><a href="${esc(content.button.href)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:${onBtn};text-decoration:none;border-radius:8px;">${esc(content.button.label)}</a></td></tr></table>
<p class="s" style="margin:0 0 14px;font-size:12px;line-height:18px;color:#8a8a85;">${esc(common.linkFallback)}<br><a href="${esc(content.button.href)}" style="color:#6b6b66;word-break:break-all;">${esc(content.button.href)}</a></p>`
    : '';
  const small = (content.small ?? []).map((s) => `<p class="s" style="margin:0 0 8px;font-size:12px;line-height:18px;color:#8a8a85;">${esc(s)}</p>`).join('');
  const footer = [common.sentBy(brand.name), brand.footer].filter(Boolean).map(esc).join(' ');
  return `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(content.subject)}</title>
<style>
@media (prefers-color-scheme: dark) {
  .bg { background: #151514 !important; }
  .card { background: #1e1e1c !important; }
  .t, .h { color: #f1f1ee !important; }
  .m { color: #c9c9c4 !important; }
  .s { color: #9a9a95 !important; }
  .code { background: #2b2b28 !important; color: #f1f1ee !important; }
}
@media only screen and (max-width: 520px) { .card { padding: 22px 18px !important; } .code { font-size: 26px !important; letter-spacing: 4px !important; } }
</style></head>
<body class="bg" style="margin:0;padding:0;background:#f4f4f1;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(content.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:#f4f4f1;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:480px;">
<tr><td class="card" style="background:#ffffff;border-radius:12px;border-top:4px solid ${brand.accent};padding:28px 28px 22px;font-family:${FONT};">
<div style="margin:0 0 20px;">${head}</div>
<h1 class="h" style="margin:0 0 12px;font-size:20px;line-height:26px;font-weight:600;color:#1d1d1b;">${esc(content.heading)}</h1>
${paragraphs}${code}${button}${small}
</td></tr>
<tr><td style="padding:14px 8px 0;text-align:center;font-family:${FONT};"><p class="s" style="margin:0 0 4px;font-size:12px;line-height:18px;color:#8a8a85;">${footer}</p><p class="s" style="margin:0;font-size:12px;line-height:18px;color:#8a8a85;">${esc(common.ignore)}</p></td></tr>
</table></td></tr></table></body></html>`;
}

function layoutText(content: Content, brand: Brand, common: Messages['common']): string {
  const parts: string[] = [content.heading, '', ...content.paragraphs.flatMap((p) => [p, ''])];
  if (content.code) parts.push(`    ${content.code}`, '');
  if (content.button) {
    if (content.buttonIntro) parts.push(content.buttonIntro);
    parts.push(`${content.button.label}: ${content.button.href}`, '');
  }
  for (const s of content.small ?? []) parts.push(s);
  parts.push('', '--', [common.sentBy(brand.name), brand.footer].filter(Boolean).join(' '), common.ignore);
  return parts.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/** Build the subject, HTML and text of one email. Safe with hostile data: everything is escaped. */
export async function renderEmail<K extends TemplateName>(
  env: Env,
  opts: { template: K; data: TemplateData[K]; orgId?: string | null; lang?: string },
): Promise<RenderedEmail> {
  const [brand, installLang] = await Promise.all([resolveBrand(env, opts.orgId), getSetting<string>(env, INSTANCE, 'language', 'en')]);
  const lang = langOf(opts.lang) ?? langOf(installLang) ?? 'en';
  const messages = DICTIONARIES[lang]!;
  const data = { ...opts.data } as Record<string, unknown>;
  for (const key of ['link']) if (typeof data[key] === 'string') data[key] = safeHref(data[key] as string);
  const content = (messages[opts.template] as (d: TemplateData[K], b: Brand) => Content)(data as TemplateData[K], brand);
  if (content.button) content.button = { ...content.button, href: safeHref(content.button.href) };
  content.subject = cleanSubject(content.subject);
  return {
    subject: content.subject,
    html: layoutHtml(content, brand, messages.common, lang),
    text: layoutText(content, brand, messages.common),
  };
}

/** Name and one-line purpose of each template, for the Email screen. */
export const TEMPLATE_INFO: Record<TemplateName, string> = {
  'sign-in-code': 'Sent when someone asks for a code to sign in.',
  'claim-code': 'Sent to the first person who sets up a new install.',
  invite: 'Sent when an admin invites someone to a workspace.',
  'email-change': 'Sent to confirm a new email address.',
  'new-device': 'Sent when an account is used from a device we have not seen.',
  test: 'Sent from the Email screen to check that sending works.',
  'export-ready': 'Sent when a workspace export is ready to download.',
  notification: 'Sent for alerts an admin chose to get by email.',
};
