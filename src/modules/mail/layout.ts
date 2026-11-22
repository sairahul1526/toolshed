/** The email wrapper: brand header, content, and the footer every newsletter must carry. */
import type { Brand } from '../../core/email-templates/types';
import { escapeHtml } from './merge';

export interface FooterInfo {
  listName: string;
  postalAddress: string;
  /** Empty for test sends and previews that have no real subscriber. */
  unsubscribeUrl: string;
  viewUrl?: string;
  /** A confirmation email: no unsubscribe link, because nothing has been subscribed yet. */
  confirm?: boolean;
  /** A one-to-one email (receipt, password reset): no newsletter wording, no unsubscribe link. */
  plain?: boolean;
  /** Plain note for readers when opens or clicks are counted. */
  tracked?: string;
}

function onAccent(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#111111' : '#ffffff';
}

export function buttonHtml(label: string, href: string, accent: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:${accent};color:${onAccent(accent)};padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(label)}</a></p>`;
}

export function layoutHtml(opts: { brand: Brand; subject: string; preheader: string; content: string; footer: FooterInfo }): string {
  const { brand, footer } = opts;
  const head = brand.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.name)}" height="32" style="height:32px;border:0">`
    : `<span style="font-size:18px;font-weight:700;color:#111">${escapeHtml(brand.name)}</span>`;
  const pre = opts.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${escapeHtml(opts.preheader)}</div>`
    : '';
  const unsub = footer.unsubscribeUrl
    ? `<a href="${escapeHtml(footer.unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a>`
    : '<span>Unsubscribe link appears here</span>';
  const view = footer.viewUrl ? ` &middot; <a href="${escapeHtml(footer.viewUrl)}" style="color:#6b7280">View in browser</a>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(opts.subject)}</title>
<style>.body p,.body li{margin:0 0 14px}.body h1{font-size:24px;margin:0 0 14px}.body h2{font-size:20px;margin:22px 0 10px}.body h3{font-size:17px;margin:18px 0 8px}.body a{color:${brand.accent}}.body img{max-width:100%;height:auto}.body blockquote{margin:0 0 14px;padding-left:14px;border-left:3px solid #d1d5db;color:#4b5563}.body pre,.body code{background:#f3f4f6;border-radius:4px}.body pre{padding:12px;overflow:auto}</style></head>
<body style="margin:0;padding:0;background:#f4f4f5">${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px"><tr><td style="padding:28px 32px 8px">${head}</td></tr>
<tr><td class="body" style="padding:8px 32px 24px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6;color:#1f2937">${opts.content}</td></tr>
<tr><td style="padding:16px 32px 28px;border-top:1px solid #e5e7eb;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#6b7280">
${footer.plain ? `Sent by ${escapeHtml(brand.name)}.` : footer.confirm ? `Someone entered this address on the ${escapeHtml(footer.listName)} signup page.` : `You get this because you subscribed to ${escapeHtml(footer.listName)}.<br>${unsub}${view}${footer.tracked ? `<br>${escapeHtml(footer.tracked)}` : ''}`}${footer.postalAddress ? `<br>${escapeHtml(footer.postalAddress).replace(/\n/g, '<br>')}` : ''}</td></tr></table>
</td></tr></table></body></html>`;
}

export function layoutText(opts: { content: string; footer: FooterInfo }): string {
  const { footer } = opts;
  const lines = [opts.content.trim(), '', '--'];
  if (footer.plain) lines.push('This is a one-to-one message about your account or an order.');
  else if (footer.confirm) lines.push(`Someone entered this address on the ${footer.listName} signup page.`);
  else {
    lines.push(`You get this because you subscribed to ${footer.listName}.`);
    lines.push(footer.unsubscribeUrl ? `Unsubscribe: ${footer.unsubscribeUrl}` : 'Unsubscribe link appears here');
    if (footer.viewUrl) lines.push(`View in browser: ${footer.viewUrl}`);
    if (footer.tracked) lines.push(footer.tracked);
  }
  if (footer.postalAddress) lines.push(footer.postalAddress);
  return lines.join('\n');
}
