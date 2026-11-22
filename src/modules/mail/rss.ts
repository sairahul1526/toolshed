/**
 * RSS to email. Point a feed at a newsletter; each new post becomes a draft broadcast (or, if you
 * choose, is sent straight away after the usual checklist). The first check only remembers what is
 * already there, so connecting a feed never emails your back catalogue.
 */
import { z } from 'zod';
import { newId } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { assertPublicUrl, safeFetch } from '../../core/net';
import type { Env } from '../../env';
import { createBroadcast } from './broadcasts';
import { startBroadcast } from './engine';
import { mailErrors } from './errors';
import { parseFeed, type FeedItem } from './feed-parse';
import { getList } from './lists';
import { ctxOf, type Ctx } from './types';

export interface Feed {
  id: string;
  org_id: string;
  list_id: string;
  url: string;
  title: string;
  mode: 'draft' | 'send';
  status: 'active' | 'paused';
  last_checked_at: number | null;
  last_error: string;
  created_at: number;
}

export const FEED_EVERY_MS = 60 * 60_000;
export const FEEDS_PER_RUN = 3;
export const NEW_PER_CHECK = 5;

export const feedInput = z.object({
  list_id: z.string().min(1),
  url: z.string().trim().url('Enter the full address of the feed, starting with https://.').max(500),
  mode: z.enum(['draft', 'send']).default('draft'),
});

export const listFeeds = (ctx: Ctx) => ctx.db.all<Feed>('SELECT * FROM mail_feeds WHERE org_id = :org ORDER BY created_at DESC');

export async function addFeed(ctx: Ctx, raw: unknown, fetcher: Fetcher = safeFetch, now = Date.now()): Promise<Feed> {
  const input = parse(feedInput, raw);
  await getList(ctx, input.list_id);
  try {
    assertPublicUrl(input.url);
  } catch {
    throw errors.validation_failed('That address can’t be used as a feed.', { url: 'Use a public https address.' });
  }
  const feed = await ctx.db.insert<Feed>('mail_feeds', { id: newId('mfd', now), list_id: input.list_id, url: input.url, title: '', mode: input.mode, status: 'active', last_error: '', created_at: now });
  await checkFeed(ctx, feed, now, fetcher);
  return (await ctx.db.get<Feed>('mail_feeds', feed.id))!;
}

export async function removeFeed(ctx: Ctx, id: string): Promise<void> {
  const f = await ctx.db.get<Feed>('mail_feeds', id);
  if (!f) throw mailErrors.feed_failed();
  await ctx.db.d1.batch([
    ctx.db.d1.prepare('DELETE FROM mail_feed_items WHERE org_id = ?1 AND feed_id = ?2').bind(ctx.org.id, id),
    ctx.db.d1.prepare('DELETE FROM mail_feeds WHERE org_id = ?1 AND id = ?2').bind(ctx.org.id, id),
  ]);
}

export async function setFeedStatus(ctx: Ctx, id: string, status: Feed['status']): Promise<Feed> {
  const f = await ctx.db.update<Feed>('mail_feeds', id, { status });
  if (!f) throw mailErrors.feed_failed();
  return f;
}

export type Fetcher = (url: string, init?: { timeoutMs?: number; maxBytes?: number }) => Promise<Response>;

const bodyFor = (item: FeedItem): string =>
  [`# ${item.title}`, item.summary, item.link ? `::button[Read the post](${item.link})` : ''].filter(Boolean).join('\n\n');

/** Fetch one feed and turn each new item into a broadcast. Dedupes on the item's guid, id or link. */
export async function checkFeed(ctx: Ctx, feed: Feed, now = Date.now(), fetcher: Fetcher = safeFetch): Promise<{ added: number; created: number }> {
  let parsed;
  try {
    const res = await fetcher(feed.url, { timeoutMs: 8000, maxBytes: 1_000_000 });
    if (!res.ok) throw new Error(`The feed answered with ${res.status}.`);
    parsed = parseFeed(await res.text());
    if (parsed.items.length === 0) throw new Error('No posts found. Is this an RSS or Atom feed?');
  } catch (err) {
    await ctx.db.update('mail_feeds', feed.id, { last_checked_at: now, last_error: (err instanceof Error ? err.message : 'The feed could not be read.').slice(0, 200) });
    return { added: 0, created: 0 };
  }
  const baseline = feed.last_checked_at === null;
  const keys = parsed.items.map((i) => i.key);
  const known = new Set(
    (await ctx.db.all<{ item_key: string }>(`SELECT item_key FROM mail_feed_items WHERE org_id = :org AND feed_id = ? AND item_key IN (${keys.map(() => '?').join(',')})`, feed.id, ...keys)).map((r) => r.item_key),
  );
  // Oldest first, so broadcasts appear in publishing order.
  const fresh = parsed.items.filter((i) => !known.has(i.key)).reverse();
  let created = 0;
  for (const [n, item] of fresh.entries()) {
    const makeBroadcast = !baseline && n >= fresh.length - NEW_PER_CHECK;
    const { changes } = await ctx.db.run(
      'INSERT OR IGNORE INTO mail_feed_items (id, org_id, feed_id, item_key, title, link, broadcast_id, created_at) VALUES (?, :org, ?, ?, ?, ?, ?, ?)',
      newId('mfi', now + n),
      feed.id,
      item.key,
      item.title.slice(0, 200),
      item.link,
      '',
      now,
    );
    if (!changes || !makeBroadcast) continue;
    const b = await createBroadcast(ctx, { list_id: feed.list_id, subject: item.title, body: bodyFor(item) }, now + n);
    await ctx.db.run('UPDATE mail_broadcasts SET source = ? WHERE org_id = :org AND id = ?', `feed:${feed.id}`, b.id);
    await ctx.db.run('UPDATE mail_feed_items SET broadcast_id = ? WHERE org_id = :org AND feed_id = ? AND item_key = ?', b.id, feed.id, item.key);
    created++;
    if (feed.mode === 'send') {
      try {
        await startBroadcast(ctx, b.id, now);
      } catch {
        // The checklist said no (for example no postal address yet). It stays a draft for a person to look at.
      }
    }
  }
  await ctx.db.update('mail_feeds', feed.id, { last_checked_at: now, last_error: '', ...(feed.title ? {} : { title: parsed.title }) });
  return { added: fresh.length, created };
}

/** Hourly schedule: look at the feeds that have waited longest. */
export async function checkDueFeeds(env: Env, now = Date.now(), fetcher: Fetcher = safeFetch): Promise<number> {
  const due = await env.DB.prepare("SELECT * FROM mail_feeds WHERE status = 'active' AND (last_checked_at IS NULL OR last_checked_at < ?1) ORDER BY COALESCE(last_checked_at, 0) LIMIT ?2")
    .bind(now - FEED_EVERY_MS + 60_000, FEEDS_PER_RUN)
    .all<Feed>();
  for (const f of due.results) await checkFeed(ctxOf(env, f.org_id), f, now, fetcher);
  return due.results.length;
}
