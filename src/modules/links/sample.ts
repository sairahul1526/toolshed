/** Believable sample rows. Every one is marked `sample = 1` so they can be cleared in one go. */
import { DAY_MS, dayOf } from './days';
import { createBio } from './bios';
import { bust } from './cache';
import { createLink } from './links';
import type { LinksCtx } from './types';

const LINKS = [
  { code: 'sample-launch', title: 'Launch post', url: 'https://example.com/blog/launch', tags: ['blog'], weight: 9 },
  { code: 'sample-docs', title: 'Getting started guide', url: 'https://example.com/docs/start', tags: ['docs'], weight: 6 },
  { code: 'sample-pricing', title: 'Pricing page', url: 'https://example.com/pricing', tags: ['site'], weight: 4 },
  { code: 'sample-newsletter', title: 'Newsletter sign-up', url: 'https://example.com/newsletter?utm_source=bio', tags: ['site'], weight: 2 },
];
const COUNTRIES = ['US', 'GB', 'IN', 'DE', 'CA'];
const REFERRERS = ['', 'news.example.com', 'social.example.net', 'search.example.org'];
const DEVICES = ['desktop', 'mobile', 'mobile', 'tablet'];
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge'];
const OSES = ['Windows', 'iOS', 'macOS', 'Android'];

/** A small deterministic generator, so the sample looks the same on every install. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

export async function addSampleData(ctx: LinksCtx, now = Date.now()): Promise<void> {
  const { DB } = ctx.env;
  const rand = seeded(7);
  for (const item of LINKS) {
    const link = await createLink(ctx, { code: item.code, title: item.title, url: item.url, tags: item.tags });
    const stmts = [DB.prepare('UPDATE links_links SET sample = 1 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, link.id)];
    for (let back = 0; back < 14; back++) {
      const day = dayOf(now - back * DAY_MS);
      const count = Math.round(item.weight * (0.4 + rand() * 1.2) * (back < 7 ? 1.3 : 0.8));
      if (!count) continue;
      stmts.push(DB.prepare('INSERT INTO links_daily (org_id, target_id, kind, day, clicks, qr, bots) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (target_id, kind, day) DO UPDATE SET clicks = excluded.clicks').bind(ctx.orgId, link.id, 'click', day, count, Math.round(count / 6), 0));
      if (back >= 7) continue;
      for (let i = 0; i < count; i++) {
        const pick = <T>(list: T[]): T => list[Math.floor(rand() * list.length)]!;
        stmts.push(
          DB.prepare(
            `INSERT INTO links_clicks (org_id, target_id, kind, at, day, visitor, country, city, device, browser, os, referrer, utm_source, utm_medium, utm_campaign, qr)
             VALUES (?1, ?2, 'click', ?3, ?4, ?5, ?6, '', ?7, ?8, ?9, ?10, '', '', '', 0)`,
          ).bind(ctx.orgId, link.id, now - back * DAY_MS - Math.floor(rand() * 3_600_000), day, `sample-${item.code}-${back}-${i % 4}`, pick(COUNTRIES), pick(DEVICES), pick(BROWSERS), pick(OSES), pick(REFERRERS)),
        );
      }
    }
    await DB.batch(stmts);
  }
  const bio = await createBio(ctx, {
    code: 'sample-me',
    name: 'Sample creator',
    bio: 'Notes, guides and the occasional experiment.',
    published: true,
    blocks: [
      { kind: 'heading', title: 'Start here' },
      { kind: 'link', title: 'Launch post', url: 'https://example.com/blog/launch' },
      { kind: 'link', title: 'Getting started guide', url: 'https://example.com/docs/start' },
      { kind: 'text', body: 'New posts every other week.' },
      { kind: 'social', platform: 'github', url: 'https://example.com/sample' },
    ],
  });
  await DB.prepare('UPDATE links_bios SET sample = 1 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, bio.id).run();
}

export async function removeSampleData(ctx: LinksCtx): Promise<void> {
  const { DB } = ctx.env;
  const org = ctx.orgId;
  const links = `SELECT id FROM links_links WHERE org_id = ?1 AND sample = 1`;
  const bios = `SELECT id FROM links_bios WHERE org_id = ?1 AND sample = 1`;
  const targets = `(${links} UNION ${bios})`;
  const codes = (await DB.prepare(`SELECT code FROM links_links WHERE org_id = ?1 AND sample = 1 UNION SELECT code FROM links_bios WHERE org_id = ?1 AND sample = 1`).bind(org).all<{ code: string }>()).results;
  await DB.batch([
    DB.prepare(`DELETE FROM links_slugs WHERE org_id = ?1 AND target_id IN ${targets}`).bind(org),
    DB.prepare(`DELETE FROM links_link_tags WHERE org_id = ?1 AND link_id IN (${links})`).bind(org),
    DB.prepare(`DELETE FROM links_bio_blocks WHERE org_id = ?1 AND bio_id IN (${bios})`).bind(org),
    DB.prepare(`DELETE FROM links_daily WHERE org_id = ?1 AND target_id IN ${targets}`).bind(org),
    DB.prepare(`DELETE FROM links_clicks WHERE org_id = ?1 AND target_id IN ${targets}`).bind(org),
    DB.prepare(`DELETE FROM links_rollups WHERE org_id = ?1 AND target_id IN ${targets}`).bind(org),
    DB.prepare(`DELETE FROM links_links WHERE org_id = ?1 AND sample = 1`).bind(org),
    DB.prepare(`DELETE FROM links_bios WHERE org_id = ?1 AND sample = 1`).bind(org),
  ]);
  for (const { code } of codes) await bust(ctx.env, code);
}
