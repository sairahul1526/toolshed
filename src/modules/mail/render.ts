/**
 * Turns an editor body into the HTML and text parts of one email for one person.
 *
 * Markdown: merge tags are filled (with Markdown punctuation escaped), then `renderMarkdown` runs,
 * and it escapes any raw HTML. Two block lines are understood on top of Markdown:
 *   ::button[Label](https://example.com)   ::image[Alt text](https://example.com/a.png)   ::divider
 * Raw HTML: merge tags are filled with escaped values, then the allow-list sanitiser runs.
 */
import { markdownToText, renderMarkdown } from '../../core/markdown';
import type { Brand } from '../../core/email-templates/types';
import { buttonHtml, layoutHtml, layoutText, type FooterInfo } from './layout';
import { escapeHtml, mergeHtml, mergeMarkdown, mergeText, type MergeValues } from './merge';
import { safeUrl, sanitizeHtml } from './sanitize';

export type BodyFormat = 'markdown' | 'html';

export interface Content {
  format: BodyFormat;
  subject: string;
  preheader: string;
  body: string;
}

export interface RenderOptions {
  brand: Brand;
  values: MergeValues;
  footer: FooterInfo;
  /** Replaces every outgoing http(s) link, for click tracking. Return the same text to leave it alone. */
  rewriteLink?: (url: string) => string;
  /** The tiny image that counts opens. */
  pixelUrl?: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

const BUTTON = /^::button\[([^\]\n]{1,80})\]\(([^)\s]+)\)\s*$/;
const IMAGE = /^::image\[([^\]\n]{0,120})\]\(([^)\s]+)\)\s*$/;
const DIVIDER = /^::divider\s*$/;

function markdownBlocks(body: string, brand: Brand): { html: string; text: string } {
  let html = '';
  const text: string[] = [];
  let chunk: string[] = [];
  const flush = () => {
    const md = chunk.join('\n').trim();
    chunk = [];
    if (!md) return;
    html += renderMarkdown(md, { allowImages: true });
    text.push(markdownToText(md));
  };
  for (const line of body.split(/\r?\n/)) {
    const button = BUTTON.exec(line);
    const image = IMAGE.exec(line);
    if (button || image) {
      const url = safeUrl(button ? button[2]! : image![2]!, false);
      if (url) {
        flush();
        if (button) {
          html += buttonHtml(button[1]!, url, brand.accent);
          text.push(`${button[1]}: ${url}`);
        } else {
          html += `<p><img src="${escapeHtml(url)}" alt="${escapeHtml(image![1]!)}" style="max-width:100%;height:auto;border-radius:8px"></p>`;
        }
        continue;
      }
    }
    if (DIVIDER.test(line)) {
      flush();
      html += '<hr style="border:0;border-top:1px solid #e5e7eb;margin:24px 0">';
      text.push('----');
      continue;
    }
    chunk.push(line);
  }
  flush();
  return { html, text: text.join('\n\n') };
}

/** Plain text from sanitised HTML: paragraphs become blank lines, links keep their address. */
export function htmlToText(html: string): string {
  return html
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, (_m, href: string, label: string) => {
      const plain = label.replace(/<[^>]+>/g, '').trim();
      const url = href.replace(/&amp;/g, '&');
      return plain && plain !== url ? `${plain} (${url})` : url;
    })
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|\/blockquote)[^>]*>/gi, '\n')
    .replace(/<hr[^>]*>/gi, '\n----\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (_m, n: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[n]!)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const HREF = /href="(https?:\/\/[^"]+)"/g;

/** Rewrite links for click tracking. The unsubscribe link is never rewritten. */
export function rewriteLinks(html: string, fn: (url: string) => string): string {
  return html.replace(HREF, (_m, url: string) => `href="${escapeHtml(fn(url.replace(/&amp;/g, '&')))}"`);
}

/** Just the body HTML, without the email wrapper. Used for the public archive and previews. */
export function renderBodyHtml(content: Pick<Content, 'format' | 'body'>, brand: Brand, values: MergeValues): string {
  if (content.format === 'html') return sanitizeHtml(mergeHtml(content.body, values));
  return markdownBlocks(mergeMarkdown(content.body, values), brand).html;
}

export function renderMail(content: Content, opts: RenderOptions): Rendered {
  const { brand, values, footer } = opts;
  const subject = mergeText(content.subject, values).replace(/\s+/g, ' ').trim().slice(0, 200);
  let bodyHtml: string;
  let bodyText: string;
  if (content.format === 'html') {
    bodyHtml = sanitizeHtml(mergeHtml(content.body, values));
    bodyText = htmlToText(bodyHtml);
  } else {
    const blocks = markdownBlocks(mergeMarkdown(content.body, values), brand);
    bodyHtml = blocks.html;
    bodyText = blocks.text;
  }
  if (opts.rewriteLink) bodyHtml = rewriteLinks(bodyHtml, opts.rewriteLink);
  const pixel = opts.pixelUrl ? `<img src="${escapeHtml(opts.pixelUrl)}" width="1" height="1" alt="" style="border:0;width:1px;height:1px">` : '';
  const preheader = mergeText(content.preheader, values);
  return {
    subject,
    html: layoutHtml({ brand, subject, preheader, content: bodyHtml, footer }) .replace('</body>', `${pixel}</body>`),
    text: layoutText({ content: bodyText, footer }),
  };
}

/** Every http(s) link in a body, for the click table and the checklist. Merge tags in an address are ignored. */
export function linksIn(content: Pick<Content, 'format' | 'body'>): string[] {
  const urls = new Set<string>();
  const add = (u: string) => {
    const clean = safeUrl(u.replace(/&amp;/g, '&'), false);
    if (clean && /^https?:/i.test(clean)) urls.add(clean);
  };
  if (content.format === 'html') for (const m of content.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)) add(m[1]!);
  else {
    for (const m of content.body.matchAll(/\]\(([^)\s]+)\)/g)) add(m[1]!);
    for (const m of content.body.matchAll(/^::button\[[^\]]*\]\(([^)\s]+)\)/gm)) add(m[1]!);
    for (const m of content.body.matchAll(/<(https?:\/\/[^>\s]+)>/g)) add(m[1]!);
  }
  return [...urls];
}
