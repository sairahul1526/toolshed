/** A small, forgiving RSS 2.0 and Atom reader. Workers have no DOM parser, so this reads the few tags we need. */
import { htmlToText } from './render';

export interface FeedItem {
  key: string;
  title: string;
  link: string;
  summary: string;
  published: number | null;
}

export interface ParsedFeed {
  title: string;
  items: FeedItem[];
}

const decodeEntities = (s: string): string =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Math.min(Number(n), 0x10ffff)))
    .replace(/&amp;/g, '&');

function tag(block: string, name: string): string {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(block);
  return m ? m[1]!.trim() : '';
}

function atomLink(block: string): string {
  const links = [...block.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]!);
  const pick = links.find((a) => /rel\s*=\s*["']alternate["']/i.test(a)) ?? links.find((a) => !/rel\s*=/i.test(a)) ?? links[0] ?? '';
  return /href\s*=\s*["']([^"']+)["']/i.exec(pick)?.[1] ?? '';
}

const plain = (s: string, max: number): string => htmlToText(decodeEntities(s)).replace(/\s+/g, ' ').trim().slice(0, max);

export function parseFeed(xml: string): ParsedFeed {
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const head = xml.slice(0, Math.max(xml.search(/<(item|entry)[\s>]/i), 0) || 4000);
  const items: FeedItem[] = [];
  for (const b of blocks.slice(0, 50)) {
    const link = decodeEntities(isAtom ? atomLink(b) : tag(b, 'link')).trim();
    const title = plain(tag(b, 'title'), 200);
    const key = decodeEntities(tag(b, isAtom ? 'id' : 'guid')).trim() || link || title;
    if (!key) continue;
    const when = tag(b, isAtom ? 'updated' : 'pubDate') || tag(b, 'published');
    const time = when ? Date.parse(decodeEntities(when)) : NaN;
    const body = tag(b, isAtom ? 'summary' : 'description') || tag(b, 'content') || tag(b, 'content:encoded');
    items.push({ key: key.slice(0, 500), title: title || '(untitled)', link: /^https?:\/\//i.test(link) ? link : '', summary: plain(body, 600), published: Number.isFinite(time) ? time : null });
  }
  return { title: plain(tag(head, 'title'), 120), items };
}
