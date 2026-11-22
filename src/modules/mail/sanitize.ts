/**
 * An allow-list HTML cleaner for the "raw HTML" editor mode. No DOM exists in a Worker, so this
 * reads the markup tag by tag: anything not on the list is dropped (its text is kept, except for
 * script, style and other tags whose contents are code), every attribute not on the list is dropped,
 * links and images keep only http, https and mailto, and inline styles keep a few safe properties.
 */
import { escapeHtml } from './merge';

const VOID = new Set(['br', 'hr', 'img']);
const ALLOWED = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
  'img', 'div', 'span', 'center', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'small', 'sup', 'sub',
]);
/** Tags whose whole contents are dropped, not just the tag. */
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'template', 'noscript', 'head', 'title', 'textarea', 'select', 'form']);

const ATTRS: Record<string, string[]> = {
  a: ['href', 'title'],
  img: ['src', 'alt', 'width', 'height'],
  td: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height', 'bgcolor'],
  th: ['align', 'valign', 'colspan', 'rowspan', 'width', 'height', 'bgcolor'],
  table: ['width', 'align', 'cellpadding', 'cellspacing', 'border', 'bgcolor'],
  tr: ['align', 'valign'],
  div: ['align'],
  p: ['align'],
  ol: ['start'],
};

const STYLE_PROPS = new Set([
  'color', 'background-color', 'font-size', 'font-weight', 'font-style', 'text-align', 'text-decoration', 'line-height', 'padding', 'padding-top',
  'padding-bottom', 'padding-left', 'padding-right', 'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right', 'border', 'border-top',
  'border-bottom', 'border-left', 'border-right', 'border-radius', 'width', 'max-width', 'height', 'display', 'letter-spacing',
]);

function decode(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|colon|tab|newline));?/g, (_m, dec?: string, hexa?: string, name?: string) => {
    if (name) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n' }[name]!;
    const code = dec ? Number(dec) : parseInt(hexa!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

/** An address a reader may follow. Compared after decoding and stripping the tricks browsers ignore. */
export function safeUrl(raw: string, allowMail: boolean): string | null {
  const url = decode(raw).replace(/[\u0000- \u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  if (url === '') return null;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  if (!scheme) return url.startsWith('//') ? null : url.startsWith('/') || url.startsWith('#') ? decode(raw).trim() : null;
  const name = scheme[1]!.toLowerCase();
  if (name === 'http' || name === 'https' || (allowMail && name === 'mailto')) return decode(raw).trim();
  return null;
}

function cleanStyle(value: string): string {
  const out: string[] = [];
  for (const part of decode(value).split(';')) {
    const at = part.indexOf(':');
    if (at < 1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const val = part.slice(at + 1).trim();
    if (!STYLE_PROPS.has(prop)) continue;
    if (/url\s*\(|expression|javascript|@import|[<>\\{}]|\/\*/i.test(val) || val.length > 80) continue;
    out.push(`${prop}:${val}`);
  }
  return out.join(';');
}

interface Tag {
  name: string;
  closing: boolean;
  attrs: Record<string, string>;
  end: number;
}

/** Read one tag starting at `<`. Handles `>` inside quoted values. Returns null when it is not a tag. */
function readTag(src: string, from: number): Tag | null {
  const head = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(src.slice(from, from + 40));
  if (!head) return null;
  let i = from + head[0].length;
  const attrs: Record<string, string> = {};
  for (;;) {
    while (i < src.length && /[\s/]/.test(src[i]!)) i++;
    if (i >= src.length) return null;
    if (src[i] === '>') return { name: head[2]!.toLowerCase(), closing: head[1] === '/', attrs, end: i + 1 };
    const name = /^[^\s=>/]+/.exec(src.slice(i, i + 60))?.[0];
    if (!name) return null;
    i += name.length;
    while (i < src.length && /\s/.test(src[i]!)) i++;
    let value = '';
    if (src[i] === '=') {
      i++;
      while (i < src.length && /\s/.test(src[i]!)) i++;
      const quote = src[i];
      if (quote === '"' || quote === "'") {
        const close = src.indexOf(quote, i + 1);
        if (close === -1) return null;
        value = src.slice(i + 1, close);
        i = close + 1;
      } else {
        const bare = /^[^\s>]*/.exec(src.slice(i))![0];
        value = bare;
        i += bare.length;
      }
    }
    const key = name.toLowerCase();
    if (!(key in attrs)) attrs[key] = value;
  }
}

/** Safe HTML for an email body. Comments, scripts, styles, forms, event handlers and unknown tags are removed. */
export function sanitizeHtml(src: string): string {
  let out = '';
  const open: string[] = [];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      out += cleanText(src.slice(i));
      break;
    }
    out += cleanText(src.slice(i, lt));
    if (src.startsWith('<!--', lt)) {
      const close = src.indexOf('-->', lt + 4);
      i = close === -1 ? src.length : close + 3;
      continue;
    }
    const tag = readTag(src, lt);
    if (!tag) {
      out += '&lt;';
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (DROP_CONTENT.has(tag.name)) {
      if (!tag.closing) {
        const re = new RegExp(`</${tag.name}\\s*>`, 'i');
        const rest = src.slice(i);
        const m = re.exec(rest);
        i = m ? i + m.index + m[0].length : src.length;
      }
      continue;
    }
    if (!ALLOWED.has(tag.name)) continue;
    if (tag.closing) {
      const at = open.lastIndexOf(tag.name);
      if (at === -1) continue;
      while (open.length > at) out += `</${open.pop()}>`;
      continue;
    }
    out += buildTag(tag);
    if (!VOID.has(tag.name)) open.push(tag.name);
  }
  while (open.length) out += `</${open.pop()}>`;
  return out;
}

/** Text between tags: keep existing character references, escape stray angle brackets and quotes. */
function cleanText(text: string): string {
  return text.replace(/&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,10});)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildTag(tag: Tag): string {
  const allowed = new Set([...(ATTRS[tag.name] ?? []), 'style']);
  const parts: string[] = [];
  for (const [key, raw] of Object.entries(tag.attrs)) {
    if (!allowed.has(key)) continue;
    let value: string | null = raw;
    if (key === 'href') value = safeUrl(raw, true);
    else if (key === 'src') value = safeUrl(raw, false);
    else if (key === 'style') value = cleanStyle(raw);
    else value = decode(raw).slice(0, 200);
    if (value === null || (value === '' && key !== 'alt')) continue;
    parts.push(` ${key}="${escapeHtml(value)}"`);
  }
  if (tag.name === 'a') parts.push(' rel="noopener noreferrer"');
  return `<${tag.name}${parts.join('')}>`;
}
