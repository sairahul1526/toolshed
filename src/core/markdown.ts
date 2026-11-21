/**
 * Markdown for text that strangers write (feedback, changelogs, form descriptions, announcements).
 *
 * `renderMarkdown` is built on `marked` but only ever produces a small, fixed set of tags with
 * attributes we write ourselves. Raw HTML in the source is escaped, never passed through; there are
 * no inline styles, no event attributes and no ids. Links keep only http, https, mailto and
 * relative addresses.
 */
import { Marked, type Token, type Tokens } from 'marked';

export interface MarkdownOptions {
  /** Render only inline markup (bold, links, code) with no paragraphs or headings. For titles and one-line fields. */
  inline?: boolean;
  /** Shift heading levels down: `1` turns `#` into `<h2>`. Levels stop at `<h6>`. */
  headingOffset?: number;
  /** Show images (http and https only). Off by default: an image becomes a link to it. */
  allowImages?: boolean;
  /** Cut the source to this many characters before rendering. */
  maxLength?: number;
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/** Characters that need escaping, but not an ampersand that already starts a character reference. */
const UNESCAPED = /[<>"']|&(?!(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|\w+);)/g;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n' };

/** Turn character references back into characters. Used to read what a browser would read. */
function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]+));?/g, (whole, dec?: string, hexa?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    const code = dec ? Number(dec) : parseInt(hexa!, 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

type Kind = 'external' | 'relative' | null;

/** `external` for http, https and mailto, `relative` for paths on this site, `null` for anything else. */
function classifyHref(href: string): Kind {
  // Browsers ignore whitespace and control characters inside a scheme, so "java\tscript:" still runs.
  const seen = decodeEntities(href).replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200f\u2028\u2029\u00a0\ufeff]/g, '');
  if (!seen) return null;
  if (/^[/\\]{2}/.test(seen) || seen.startsWith('\\')) return null; // protocol-relative: could point anywhere
  const colon = seen.search(/[:/?#]/);
  if (colon !== -1 && seen[colon] === ':') {
    return /^(?:https?|mailto):/i.test(seen) ? 'external' : null;
  }
  return 'relative';
}

function isHttp(href: string): boolean {
  return /^https?:/i.test(decodeEntities(href).replace(/[\u0000- ]/g, ''));
}

function build(opts: MarkdownOptions): Marked {
  const offset = Math.max(0, Math.floor(opts.headingOffset ?? 0));
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      // Raw HTML, block or inline, is shown as text.
      html({ text }) {
        return escapeHtml(text);
      },
      // After a raw HTML tag such as <script>, marked hands later text through unescaped. Escape it
      // ourselves, keeping character references the author typed (&amp; stays &amp;).
      text(token) {
        if ('tokens' in token && token.tokens) return this.parser.parseInline(token.tokens);
        return token.text.replace(UNESCAPED, (ch) => ESCAPES[ch] ?? '&amp;');
      },
      heading({ tokens, depth }) {
        const level = Math.min(6, depth + offset);
        return `<h${level}>${this.parser.parseInline(tokens)}</h${level}>\n`;
      },
      code({ text, lang }) {
        const language = /^[\w+#.-]{1,30}$/.exec((lang ?? '').trim().split(/\s/)[0] ?? '')?.[0];
        return `<pre><code${language ? ` class="language-${language}"` : ''}>${escapeHtml(text)}\n</code></pre>\n`;
      },
      link({ href, title, tokens }) {
        const inner = this.parser.parseInline(tokens);
        const kind = classifyHref(href);
        if (!kind) return inner;
        const attrs = [`href="${escapeHtml(href)}"`];
        if (title) attrs.push(`title="${escapeHtml(title)}"`);
        if (kind === 'external') attrs.push('target="_blank"', 'rel="noopener nofollow ugc"');
        return `<a ${attrs.join(' ')}>${inner}</a>`;
      },
      image({ href, title, text }) {
        const kind = classifyHref(href);
        if (opts.allowImages && kind === 'external' && isHttp(href)) {
          const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
          return `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"${titleAttr} loading="lazy">`;
        }
        const label = escapeHtml(text || href);
        if (!kind) return label;
        const external = kind === 'external' ? ' target="_blank" rel="noopener nofollow ugc"' : '';
        return `<a href="${escapeHtml(href)}"${external}>${label}</a>`;
      },
    },
  });
  return marked;
}

/** Cut at `max` characters without leaving half of an emoji behind. */
function cut(text: string, max: number): string {
  if (text.length <= max) return text;
  const end = /[\ud800-\udbff]/.test(text[max - 1] ?? '') ? max - 1 : max;
  return text.slice(0, end);
}

/** Safe HTML for a piece of markdown. See the file comment for exactly what is allowed. */
export function renderMarkdown(src: string, opts: MarkdownOptions = {}): string {
  const text = opts.maxLength !== undefined ? cut(src, Math.max(0, opts.maxLength)) : src;
  const marked = build(opts);
  return (opts.inline ? marked.parseInline(text) : marked.parse(text)) as string;
}

// ---------------------------------------------------------------------------------------------
// Plain text
// ---------------------------------------------------------------------------------------------

function inlineText(tokens: Token[] | undefined): string {
  return (tokens ?? []).map(oneInline).join('');
}

function oneInline(token: Token): string {
  switch (token.type) {
    case 'text':
    case 'escape': {
      const t = token as Tokens.Text;
      return t.tokens ? inlineText(t.tokens) : decodeEntities(t.text);
    }
    case 'codespan':
      return (token as Tokens.Codespan).text;
    case 'br':
      return '\n';
    case 'image':
      return (token as Tokens.Image).text;
    case 'link': {
      const link = token as Tokens.Link;
      const label = inlineText(link.tokens);
      const href = decodeEntities(link.href);
      // Email text parts have no links, so keep the address next to its label.
      if (classifyHref(link.href) === 'external' && href !== label && href !== `mailto:${label}`) return `${label} (${href})`;
      return label;
    }
    case 'html':
      return (token as Tokens.HTML).text;
    case 'checkbox':
      return (token as Tokens.Checkbox).checked ? '[x] ' : '[ ] ';
    default: {
      const t = token as Tokens.Generic;
      return t.tokens ? inlineText(t.tokens) : decodeEntities(t.text ?? t.raw ?? '');
    }
  }
}

function blockText(tokens: Token[]): string {
  const parts: string[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
      case 'def':
      case 'hr':
        break;
      case 'code':
        parts.push((token as Tokens.Code).text);
        break;
      case 'html':
        parts.push((token as Tokens.HTML).text.trim());
        break;
      case 'blockquote':
        parts.push(blockText((token as Tokens.Blockquote).tokens));
        break;
      case 'list': {
        const list = token as Tokens.List;
        const start = typeof list.start === 'number' ? list.start : 1;
        parts.push(
          list.items
            .map((item, i) => {
              // A task list box is its own token in front of the item's text.
              const [first, ...rest] = item.tokens;
              const box = first?.type === 'checkbox' ? ((first as Tokens.Checkbox).checked ? '[x] ' : '[ ] ') : '';
              return `${list.ordered ? `${start + i}.` : '-'} ${box}${blockText(box ? rest : item.tokens).replace(/\n+/g, '\n  ')}`;
            })
            .join('\n'),
        );
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        const row = (cells: Tokens.TableCell[]) => cells.map((c) => inlineText(c.tokens)).join(' | ');
        parts.push([row(table.header), ...table.rows.map(row)].join('\n'));
        break;
      }
      default:
        parts.push(oneInline(token));
    }
  }
  return parts.filter((p) => p !== '').join('\n\n');
}

/** Plain text for email text parts and search: no markup, links keep their address, blocks are separated by blank lines. */
export function markdownToText(src: string): string {
  return blockText(new Marked({ gfm: true }).lexer(src)).replace(/[ \t]+\n/g, '\n').trim();
}

/** The start of a piece of markdown as plain text, cut at a word boundary with an ellipsis. */
export function excerpt(src: string, max = 160): string {
  const flat = markdownToText(src).replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const room = Math.max(0, max - 1);
  const slice = cut(flat, room);
  // Cut at the last space unless that would throw away most of the text (one very long word).
  const space = slice.lastIndexOf(' ');
  const base = flat[slice.length] === ' ' ? slice : space > room * 0.5 ? slice.slice(0, space) : slice;
  return `${base.replace(/[\s.,;:!?-]+$/, '')}…`;
}
