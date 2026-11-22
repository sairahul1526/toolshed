/** Abuse controls: the destination domain blocklist and the public report form. */
import { z } from 'zod';
import { likeEscape } from '../../core/audit';
import { newId } from '../../core/db';
import { errors, parse } from '../../core/errors';
import { emit } from '../../core/events';
import type { Env } from '../../env';
import { bust } from './cache';
import { disableLink, deleteLink } from './links';
import { linkErrors } from './errors';
import type { LinksCtx } from './types';
import { hostOf, matchBlocked, normalizeDomain } from './validate';

export interface BlockedDomain {
  id: string;
  domain: string;
  createdAt: string;
}

export async function listBlocked(ctx: LinksCtx): Promise<BlockedDomain[]> {
  const { results } = await ctx.env.DB.prepare('SELECT id, domain, created_at FROM links_blocked_domains WHERE org_id = ?1 ORDER BY domain').bind(ctx.orgId).all<{ id: string; domain: string; created_at: number }>();
  return results.map((r) => ({ id: r.id, domain: r.domain, createdAt: new Date(r.created_at).toISOString() }));
}

const reasonFor = (domain: string): string => `Destination domain blocked: ${domain}`;

/** Block a domain. Links already pointing there are switched off, and bio blocks that point there are hidden. */
export async function addBlocked(ctx: LinksCtx, raw: unknown): Promise<{ domain: BlockedDomain; disabledLinks: number; hiddenBlocks: number }> {
  const { domain: input } = parse(z.object({ domain: z.string().trim().min(1, 'Enter a domain such as example.com.').max(253) }), raw);
  const domain = normalizeDomain(input);
  if (!domain) throw errors.validation_failed('Enter a domain such as example.com.', { domain: 'Enter a domain such as example.com.' });
  const { DB } = ctx.env;
  const id = newId('blk');
  const now = Date.now();
  try {
    await DB.prepare('INSERT INTO links_blocked_domains (id, org_id, domain, created_by, created_at) VALUES (?1, ?2, ?3, ?4, ?5)').bind(id, ctx.orgId, domain, ctx.actorId ?? null, now).run();
  } catch (e) {
    if (/UNIQUE/i.test(String(e))) throw errors.conflict('That domain is already blocked.', { domain: 'That domain is already blocked.' });
    throw e;
  }
  const like = `%${likeEscape(domain)}%`;
  const { results: links } = await DB.prepare(`SELECT id, code, url FROM links_links WHERE org_id = ?1 AND status <> 'disabled' AND url LIKE ?2 ESCAPE '\\'`).bind(ctx.orgId, like).all<{ id: string; code: string; url: string }>();
  const hit = links.filter((l) => matchBlocked(hostOf(l.url), [domain]));
  for (const l of hit) await disableLink(ctx, l.id, reasonFor(domain));
  const { results: blocks } = await DB.prepare(`SELECT b.id, b.url, i.code FROM links_bio_blocks b JOIN links_bios i ON i.id = b.bio_id WHERE b.org_id = ?1 AND b.visible = 1 AND b.url LIKE ?2 ESCAPE '\\'`).bind(ctx.orgId, like).all<{ id: string; url: string; code: string }>();
  const hiddenBlocks = blocks.filter((b) => matchBlocked(hostOf(b.url), [domain]));
  if (hiddenBlocks.length) {
    await DB.batch(hiddenBlocks.map((b) => DB.prepare('UPDATE links_bio_blocks SET visible = 0 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, b.id)));
    await bust(ctx.env, ...new Set(hiddenBlocks.map((b) => b.code)));
  }
  return { domain: { id, domain, createdAt: new Date(now).toISOString() }, disabledLinks: hit.length, hiddenBlocks: hiddenBlocks.length };
}

/** Unblock a domain. Links that were switched off because of it come back. */
export async function removeBlocked(ctx: LinksCtx, id: string): Promise<number> {
  const row = await ctx.env.DB.prepare('SELECT domain FROM links_blocked_domains WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id).first<{ domain: string }>();
  if (!row) throw errors.not_found('We couldn’t find that domain.');
  await ctx.env.DB.prepare('DELETE FROM links_blocked_domains WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id).run();
  const { results } = await ctx.env.DB.prepare(`SELECT id, code FROM links_links WHERE org_id = ?1 AND status = 'disabled' AND disabled_reason = ?2`).bind(ctx.orgId, reasonFor(row.domain)).all<{ id: string; code: string }>();
  if (results.length) {
    await ctx.env.DB.batch(results.map((l) => ctx.env.DB.prepare(`UPDATE links_links SET status = 'active', disabled_reason = NULL, updated_at = ?3 WHERE org_id = ?1 AND id = ?2`).bind(ctx.orgId, l.id, Date.now())));
    await bust(ctx.env, ...results.map((l) => l.code));
  }
  return results.length;
}

// ---------------------------------------------------------------------------------------------
// Reports from the public form
// ---------------------------------------------------------------------------------------------

export const REPORT_REASONS = ['spam', 'phishing', 'malware', 'illegal', 'other'] as const;

export const reportSchema = z.object({
  reason: z.enum(REPORT_REASONS, { error: 'Pick what is wrong with this link.' }),
  details: z.string().trim().max(1000).optional(),
  contact: z.string().trim().max(200).optional(),
});

export interface ReportRow {
  id: string;
  org_id: string;
  target_id: string;
  code: string;
  reason: string;
  details: string;
  contact: string;
  status: 'open' | 'dismissed' | 'actioned';
  created_at: number;
}

/** Store a report from the public form. No sign-in; the caller has already rate limited it. */
export async function createReport(env: Env, code: string, raw: unknown): Promise<void> {
  const input = parse(reportSchema, raw);
  const slug = await env.DB.prepare('SELECT org_id, kind, target_id FROM links_slugs WHERE code = ?1').bind(code.toLowerCase()).first<{ org_id: string; kind: string; target_id: string }>();
  if (!slug) throw linkErrors.not_found();
  const id = newId('rep');
  await env.DB.prepare('INSERT INTO links_reports (id, org_id, target_id, code, reason, details, contact, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)')
    .bind(id, slug.org_id, slug.target_id, code.toLowerCase(), input.reason, input.details ?? '', input.contact ?? '', 'open', Date.now())
    .run();
  await emit(env, { orgId: slug.org_id, module: 'links', name: 'link.reported', subject: slug.target_id, data: { code: code.toLowerCase(), reason: input.reason, reportId: id } });
}

export async function listReports(ctx: LinksCtx, status: 'open' | 'all' = 'open'): Promise<ReportRow[]> {
  const sql = `SELECT * FROM links_reports WHERE org_id = ?1 ${status === 'open' ? `AND status = 'open'` : ''} ORDER BY id DESC LIMIT 200`;
  return (await ctx.env.DB.prepare(sql).bind(ctx.orgId).all<ReportRow>()).results;
}

export async function countOpenReports(ctx: LinksCtx): Promise<number> {
  const r = await ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM links_reports WHERE org_id = ?1 AND status = 'open'`).bind(ctx.orgId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Dismiss a report, switch the link off, or delete the link. All reports for that link are closed with it. */
export async function resolveReport(ctx: LinksCtx, id: string, action: 'dismiss' | 'disable' | 'delete'): Promise<void> {
  const rep = await ctx.env.DB.prepare('SELECT * FROM links_reports WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id).first<ReportRow>();
  if (!rep) throw errors.not_found('We couldn’t find that report.');
  if (action === 'disable') await disableLink(ctx, rep.target_id, 'Switched off after a report').catch(() => undefined);
  if (action === 'delete') await deleteLink(ctx, rep.target_id).catch(() => undefined);
  const status = action === 'dismiss' ? 'dismissed' : 'actioned';
  if (action === 'dismiss') await ctx.env.DB.prepare('UPDATE links_reports SET status = ?3 WHERE org_id = ?1 AND id = ?2').bind(ctx.orgId, id, status).run();
  else await ctx.env.DB.prepare(`UPDATE links_reports SET status = ?3 WHERE org_id = ?1 AND target_id = ?2 AND status = 'open'`).bind(ctx.orgId, rep.target_id, status).run();
}
