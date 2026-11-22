/** CSV import (with a column-mapping step) and CSV export of links, daily clicks and recent clicks. */
import { csvRow, toCsv } from '../../core/csv';
import { guessColumns, parseCsv } from '../../core/csv-parse';
import { errors } from '../../core/errors';
import { emit } from '../../core/events';
import { baseRow, linkStatements, prepare, type Prepared } from './links';
import { randomCode } from './codes';
import { linkErrors } from './errors';
import { createLinkSchema, tagSchema, toMs } from './schemas';
import { getSettings } from './settings';
import { resolveRange } from './days';
import type { LinkRow, LinksCtx } from './types';
import { blockedDomains } from './validate';
import { normalizeCode } from './codes';
import { bust } from './cache';

export const IMPORT_MAX_ROWS = 1000;

/** Header names each field may go by in exports from Bitly, Dub, Short.io and plain spreadsheets. */
export const IMPORT_ALIASES = {
  url: ['long_url', 'long url', 'destination url', 'destination', 'original url', 'originalurl', 'url', 'target url', 'target'],
  code: ['custom_back_half', 'back-half', 'back half', 'backhalf', 'key', 'slug', 'path', 'short code', 'code', 'keyword'],
  short: ['short url', 'short link', 'shortlink', 'short_url', 'bitly link', 'link'],
  title: ['title', 'name'],
  tags: ['tags', 'tag', 'labels'],
  notes: ['notes', 'description', 'comment', 'comments'],
  expires: ['expires', 'expires at', 'expiresat', 'expiration', 'expiry', 'expiration date'],
} as const;
export type ImportField = keyof typeof IMPORT_ALIASES;
export type ImportMapping = Record<ImportField, number | null>;

export interface ImportPreview {
  headers: string[];
  sample: string[][];
  rowCount: number;
  truncated: boolean;
  mapping: ImportMapping;
}

/** Read the file and guess which column is which, so the person can check it before importing. */
export function previewImport(text: string): ImportPreview {
  const parsed = parseCsv(text, { maxRows: IMPORT_MAX_ROWS });
  if (!parsed.headers.length) throw errors.validation_failed('That file is empty.', { file: 'That file is empty.' });
  const wanted = Object.fromEntries(Object.entries(IMPORT_ALIASES).map(([k, v]) => [k, [...v]]));
  return { headers: parsed.headers, sample: parsed.rows.slice(0, 5), rowCount: parsed.rows.length, truncated: parsed.truncated, mapping: guessColumns(parsed.headers, wanted) as ImportMapping };
}

export interface SkippedRow {
  /** Row number in the file, counting the header as row 1. */
  row: number;
  reason: string;
  url: string;
}

export interface ImportResult {
  created: number;
  skipped: SkippedRow[];
  truncated: boolean;
}

/** Take a short code from a short link someone else made, such as https://bit.ly/abc123. */
function codeFromShort(short: string): string {
  try {
    return new URL(short).pathname.split('/').filter(Boolean).pop()?.toLowerCase() ?? '';
  } catch {
    return '';
  }
}

async function freeCodes(ctx: LinksCtx, n: number, length: number, avoid: Set<string>): Promise<string[]> {
  const out: string[] = [];
  while (out.length < n) {
    const batch = Array.from({ length: Math.min(90, n - out.length) }, () => randomCode(length)).filter((c) => !avoid.has(c));
    const { results } = await ctx.env.DB.prepare(`SELECT code FROM links_slugs WHERE code IN (${batch.map((_, i) => `?${i + 1}`).join(', ')})`).bind(...batch).all<{ code: string }>();
    const taken = new Set(results.map((r) => r.code));
    for (const c of batch) if (!taken.has(c) && !avoid.has(c)) {
      avoid.add(c);
      out.push(c);
    }
  }
  return out;
}

async function takenCodes(ctx: LinksCtx, codes: string[]): Promise<Set<string>> {
  const taken = new Set<string>();
  for (let i = 0; i < codes.length; i += 90) {
    const chunk = codes.slice(i, i + 90);
    const { results } = await ctx.env.DB.prepare(`SELECT code FROM links_slugs WHERE code IN (${chunk.map((_, j) => `?${j + 1}`).join(', ')})`).bind(...chunk).all<{ code: string }>();
    for (const r of results) taken.add(r.code);
  }
  return taken;
}

/**
 * Import links from CSV text using the column mapping the person confirmed. Rows that cannot be
 * imported are reported, never silently dropped. Up to 1,000 rows; the rest are reported as left out.
 */
export async function runImport(ctx: LinksCtx, text: string, mapping: Partial<ImportMapping>): Promise<ImportResult> {
  const parsed = parseCsv(text, { maxRows: IMPORT_MAX_ROWS });
  if (mapping.url === null || mapping.url === undefined) throw errors.validation_failed('Pick the column that holds the web address.', { url: 'Pick the column that holds the web address.' });
  const [settings, blocked] = await Promise.all([getSettings(ctx.env, ctx.orgId), blockedDomains(ctx.env, ctx.orgId)]);
  const cell = (row: string[], f: ImportField): string => {
    const i = mapping[f];
    return i === null || i === undefined ? '' : (row[i] ?? '').trim();
  };

  interface Pending { rowNo: number; url: string; code: string | null; derived: boolean; prepared: Prepared }
  const skipped: SkippedRow[] = [];
  const pending: Pending[] = [];
  for (const [i, row] of parsed.rows.entries()) {
    const rowNo = i + 2;
    const url = cell(row, 'url');
    try {
      const tags = cell(row, 'tags').split(/[;,|]/).map((t) => t.trim().toLowerCase()).filter(Boolean);
      const cleanTags = tags.filter((t) => tagSchema.safeParse(t).success).slice(0, 20);
      const expires = cell(row, 'expires');
      const input = createLinkSchema.parse({
        url,
        title: cell(row, 'title').slice(0, 200),
        notes: cell(row, 'notes').slice(0, 2000),
        tags: cleanTags,
        ...(expires && toMs(expires, 'expires') !== null ? { expiresAt: expires } : {}),
      });
      const prepared = await prepare(ctx, input, blocked);
      let code: string | null = null;
      let derived = false;
      const given = cell(row, 'code');
      if (given) code = normalizeCode(given);
      else {
        const fromShort = codeFromShort(cell(row, 'short'));
        if (fromShort) {
          try {
            code = normalizeCode(fromShort);
            derived = true;
          } catch {
            code = null;
          }
        }
      }
      pending.push({ rowNo, url, code, derived, prepared });
    } catch (e) {
      skipped.push({ row: rowNo, url, reason: (e as { message?: string }).message ?? 'This row could not be read.' });
    }
  }

  // Codes: one pass to see which wanted codes are free, then random ones for the rest.
  const wanted = pending.filter((p) => p.code).map((p) => p.code!);
  const taken = await takenCodes(ctx, wanted);
  const used = new Set<string>();
  const needRandom: Pending[] = [];
  const ready: Pending[] = [];
  for (const p of pending) {
    if (p.code && (taken.has(p.code) || used.has(p.code))) {
      if (p.derived) p.code = null;
      else {
        skipped.push({ row: p.rowNo, url: p.url, reason: linkErrors.code_taken().message });
        continue;
      }
    }
    if (p.code) {
      used.add(p.code);
      ready.push(p);
    } else needRandom.push(p);
  }
  const randoms = await freeCodes(ctx, needRandom.length, settings.codeLength, used);
  needRandom.forEach((p, i) => {
    p.code = randoms[i]!;
    ready.push(p);
  });

  const rows: { p: Pending; row: LinkRow; tags: string[] }[] = ready.map((p, i) => ({ p, row: baseRow(ctx, p.code!, p.prepared, { redirect: settings.defaultRedirectType }, Date.now() + i), tags: p.prepared._tags ?? [] }));
  let created = 0;
  const { DB } = ctx.env;
  let chunk: typeof rows = [];
  let weight = 0;
  const flush = async () => {
    if (!chunk.length) return;
    const stmts = chunk.flatMap((r) => linkStatements(ctx, r.row, r.tags));
    try {
      await DB.batch(stmts);
      created += chunk.length;
    } catch {
      // Someone claimed a code while we worked. Fall back to one row at a time and report the clashes.
      for (const r of chunk) {
        try {
          await DB.batch(linkStatements(ctx, r.row, r.tags));
          created++;
        } catch {
          skipped.push({ row: r.p.rowNo, url: r.p.url, reason: linkErrors.code_taken().message });
        }
      }
    }
    chunk = [];
    weight = 0;
  };
  for (const r of rows) {
    const w = 2 + r.tags.length;
    if (weight + w > 90) await flush();
    chunk.push(r);
    weight += w;
  }
  await flush();
  if (parsed.truncated) skipped.push({ row: IMPORT_MAX_ROWS + 2, url: '', reason: `Only the first ${IMPORT_MAX_ROWS} rows were imported. Import the rest in another file.` });
  if (created) await emit(ctx.env, { orgId: ctx.orgId, module: 'links', name: 'link.created', subject: rows[0]?.row.id, count: created, data: { bulk: true, import: true, count: created } });
  skipped.sort((a, b) => a.row - b.row);
  return { created, skipped, truncated: parsed.truncated };
}

export function skippedCsv(skipped: SkippedRow[]): string {
  return toCsv(skipped.map((s) => ({ row: s.row, url: s.url, reason: s.reason })), { columns: ['row', 'url', 'reason'], bom: true });
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const EXPORT_LIMIT = 10_000;

export async function exportLinksCsv(ctx: LinksCtx): Promise<string> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT l.code, l.url, l.title, l.notes, l.status, l.redirect_type, l.created_at, l.expires_at, l.click_cap, f.name AS folder,
       (SELECT group_concat(t.tag, ';') FROM links_link_tags t WHERE t.link_id = l.id) AS tags,
       (SELECT COALESCE(SUM(d.clicks), 0) FROM links_daily d WHERE d.target_id = l.id AND d.kind = 'click') AS clicks
     FROM links_links l LEFT JOIN links_folders f ON f.id = l.folder_id
     WHERE l.org_id = ?1 ORDER BY l.id LIMIT ${EXPORT_LIMIT}`,
  )
    .bind(ctx.orgId)
    .all<Record<string, unknown>>();
  const rows = results.map((r) => ({
    short_url: `${ctx.base}/${r.code}`,
    code: r.code,
    url: r.url,
    title: r.title,
    notes: r.notes,
    status: r.status,
    redirect_type: r.redirect_type,
    tags: r.tags ?? '',
    folder: r.folder ?? '',
    clicks: r.clicks,
    click_cap: r.click_cap ?? '',
    expires_at: r.expires_at ? new Date(r.expires_at as number).toISOString() : '',
    created_at: new Date(r.created_at as number).toISOString(),
  }));
  return toCsv(rows, { bom: true, columns: ['short_url', 'code', 'url', 'title', 'notes', 'status', 'redirect_type', 'tags', 'folder', 'clicks', 'click_cap', 'expires_at', 'created_at'] });
}

/** Day totals per link for a range. Kept long term, so this goes as far back as the range asks. */
export async function exportDailyCsv(ctx: LinksCtx, opts: { days?: number; from?: string; to?: string } = {}): Promise<string> {
  const { from, to } = resolveRange(opts);
  const { results } = await ctx.env.DB.prepare(
    `SELECT d.day, l.code, d.clicks, d.qr AS qr_scans, d.bots FROM links_daily d JOIN links_links l ON l.id = d.target_id
     WHERE d.org_id = ?1 AND d.kind = 'click' AND d.day BETWEEN ?2 AND ?3 ORDER BY d.day, l.code LIMIT ${EXPORT_LIMIT}`,
  )
    .bind(ctx.orgId, from, to)
    .all<Record<string, unknown>>();
  return toCsv(results, { bom: true, columns: ['day', 'code', 'clicks', 'qr_scans', 'bots'] });
}

/** The raw clicks still kept (about the last 8 days): one row per person's click, with no IP address. */
export async function exportClicksCsv(ctx: LinksCtx): Promise<string> {
  const { results } = await ctx.env.DB.prepare(
    `SELECT c.at, l.code, c.country, c.city, c.device, c.browser, c.os, c.referrer, c.utm_source, c.utm_medium, c.utm_campaign, c.qr
     FROM links_clicks c JOIN links_links l ON l.id = c.target_id
     WHERE c.org_id = ?1 AND c.kind = 'click' ORDER BY c.at DESC LIMIT ${EXPORT_LIMIT}`,
  )
    .bind(ctx.orgId)
    .all<Record<string, unknown>>();
  let out = '﻿' + csvRow(['time', 'code', 'country', 'city', 'device', 'browser', 'os', 'referrer', 'utm_source', 'utm_medium', 'utm_campaign', 'via_qr']);
  for (const r of results) {
    out += csvRow([new Date(r.at as number).toISOString(), r.code, r.country, r.city, r.device, r.browser, r.os, r.referrer, r.utm_source, r.utm_medium, r.utm_campaign, r.qr ? 'yes' : 'no']);
  }
  return out;
}

export { bust };
