/** Export everything, and import posts from a CSV (built for Canny exports, with column mapping). */
import { newId } from '../../core/db';
import { toCsv } from '../../core/csv';
import { fbErrors } from './errors';
import { parseCsv } from './lib';
import { initialStatus, listBoards, listStatuses, listTags, type Ctx } from './portal';
import type { Board, Status } from './types';
import { cleanBody, TITLE_MAX } from './posts';
import { clamp, isEmail, normaliseEmail, randomSuffix, slugify } from './util';

export const IMPORT_FIELDS = ['title', 'body', 'author_name', 'author_email', 'votes', 'status', 'board', 'category', 'tags', 'created_at'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export type Mapping = Partial<Record<ImportField, number>>;

export const IMPORT_ROW_LIMIT = 200;

const GUESSES: Record<ImportField, string[]> = {
  title: ['title', 'post title', 'name', 'subject', 'idea'],
  body: ['details', 'description', 'body', 'content', 'text'],
  author_name: ['author name', 'author', 'name of author', 'user name', 'created by'],
  author_email: ['author email', 'email', 'user email', 'author email address'],
  votes: ['votes', 'vote count', 'score', 'upvotes'],
  status: ['status', 'state'],
  board: ['board', 'board name', 'category board'],
  category: ['category', 'category name'],
  tags: ['tags', 'labels'],
  created_at: ['created', 'created at', 'created date', 'date', 'post date'],
};

/** Pick a column for each field by header name. Canny's export headers match without any help. */
export function guessMapping(headers: string[]): Mapping {
  const out: Mapping = {};
  const norm = headers.map((h) => h.trim().toLowerCase().replace(/[_-]+/g, ' '));
  for (const field of IMPORT_FIELDS) {
    const idx = norm.findIndex((h) => GUESSES[field].includes(h));
    if (idx >= 0) out[field] = idx;
  }
  return out;
}

export interface Preview {
  headers: string[];
  rows: string[][];
  total: number;
  mapping: Mapping;
  truncated: boolean;
}

export function previewCsv(text: string): Preview {
  const parsed = parseCsv(text, { maxRows: 5000 });
  const rows = (parsed.rows as unknown as (string[] | Record<string, string>)[]).map((r) => (Array.isArray(r) ? r : parsed.headers.map((h) => (r as Record<string, string>)[h] ?? '')));
  return { headers: parsed.headers, rows: rows.slice(0, 5), total: rows.length, mapping: guessMapping(parsed.headers), truncated: parsed.truncated };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  notes: string[];
}

function cell(row: string[], idx: number | undefined): string {
  return idx === undefined ? '' : (row[idx] ?? '').trim();
}

function parseDate(v: string): number | null {
  if (!v) return null;
  const n = Date.parse(v);
  return Number.isFinite(n) && n > 0 && n <= Date.now() + 86400000 ? n : null;
}

/** Import up to IMPORT_ROW_LIMIT rows starting at `offset`. Imported people are unverified and are never emailed. */
export async function importPosts(ctx: Ctx, text: string, mapping: Mapping, offset = 0): Promise<ImportResult & { next: number | null }> {
  if (mapping.title === undefined) throw fbErrors.import_invalid('Choose which column holds the post title.');
  const parsed = parseCsv(text, { maxRows: 5000 });
  const all = (parsed.rows as unknown as (string[] | Record<string, string>)[]).map((r) => (Array.isArray(r) ? r : parsed.headers.map((h) => (r as Record<string, string>)[h] ?? '')));
  if (all.length === 0) throw fbErrors.import_invalid('That file has no rows.');
  const slice = all.slice(offset, offset + IMPORT_ROW_LIMIT);
  const boards = await listBoards(ctx);
  const statuses = await listStatuses(ctx);
  const tags = await listTags(ctx);
  const initial = await initialStatus(ctx);
  const byBoard = new Map<string, Board>(boards.map((b) => [b.name.toLowerCase(), b]));
  const byStatus = new Map<string, Status>(statuses.map((s) => [s.name.toLowerCase(), s]));
  const byTag = new Map(tags.map((t) => [t.name.toLowerCase(), t.id]));
  const notes: string[] = [];
  let skipped = 0;
  const stmts: D1PreparedStatement[] = [];
  const DB = ctx.env.DB;
  const personEmails = new Set<string>();
  let imported = 0;
  for (const row of slice) {
    const title = cell(row, mapping.title).replace(/\s+/g, ' ').slice(0, TITLE_MAX);
    if (title.length < 3) {
      skipped++;
      continue;
    }
    let board = byBoard.get(cell(row, mapping.board).toLowerCase()) ?? boards[0]!;
    const boardName = cell(row, mapping.board);
    if (boardName && !byBoard.has(boardName.toLowerCase()) && byBoard.size < 20) {
      const id = newId('fbb');
      const slug = `${slugify(boardName, 34, 'board')}-${randomSuffix(3)}`;
      stmts.push(DB.prepare(`INSERT INTO fb_boards (id, org_id, slug, name, description, position, visibility, voting_on, hide_votes, moderate, posting_on, created_at) VALUES (?1, ?2, ?3, ?4, '', ?5, 'public', 1, 0, 0, 1, ?6)`).bind(id, ctx.orgId, slug, boardName.slice(0, 60), byBoard.size, Date.now()));
      board = { id, slug, name: boardName } as Board;
      byBoard.set(boardName.toLowerCase(), board);
    }
    const status = byStatus.get(cell(row, mapping.status).toLowerCase()) ?? initial;
    const email = normaliseEmail(cell(row, mapping.author_email));
    const personId = isEmail(email) ? `fbu_imp_${email}` : null;
    const now = Date.now();
    if (personId && !personEmails.has(email)) {
      personEmails.add(email);
      stmts.push(
        DB.prepare(`INSERT OR IGNORE INTO fb_people (id, org_id, email, name, source, verified, trusted, blocked, mail_off, sample, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 'import', 0, 0, 0, 0, 0, ?5, ?5)`).bind(newId('fbu', now), ctx.orgId, email, cell(row, mapping.author_name).slice(0, 60), now),
      );
    }
    const postId = newId('fbq', now);
    const created = parseDate(cell(row, mapping.created_at)) ?? now;
    const votes = clamp(Number.parseInt(cell(row, mapping.votes), 10) || 0, 0, 100000);
    stmts.push(
      DB.prepare(
        `INSERT INTO fb_posts (id, org_id, board_id, slug, title, body, author_id, category_id, status_id, review, source, vote_count, comment_count, trend, voted_milestone, status_changed_at, sample, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT id FROM fb_people WHERE org_id = ?2 AND email = ?7), (SELECT id FROM fb_categories WHERE org_id = ?2 AND board_id = ?3 AND LOWER(name) = ?8), ?9, 'published', 'import', ?10, 0, 0, ?10, ?11, 0, ?11, ?11)`,
      ).bind(postId, ctx.orgId, board.id, `${slugify(title, 50)}-${randomSuffix(5)}`, title, cleanBody(cell(row, mapping.body).slice(0, 5000)), email || '-', cell(row, mapping.category).toLowerCase() || '-', status?.id ?? null, votes, created),
    );
    for (const name of cell(row, mapping.tags).split(/[;,|]/).map((t) => t.trim()).filter(Boolean).slice(0, 5)) {
      let tagId = byTag.get(name.toLowerCase());
      if (!tagId) {
        tagId = newId('fbt');
        byTag.set(name.toLowerCase(), tagId);
        stmts.push(DB.prepare('INSERT INTO fb_tags (id, org_id, name, is_public) VALUES (?1, ?2, ?3, 0)').bind(tagId, ctx.orgId, name.slice(0, 30)));
      }
      stmts.push(DB.prepare('INSERT OR IGNORE INTO fb_post_tags (org_id, post_id, tag_id) VALUES (?1, ?2, ?3)').bind(ctx.orgId, postId, tagId));
    }
    imported++;
  }
  for (let i = 0; i < stmts.length; i += 80) await DB.batch(stmts.slice(i, i + 80));
  if (imported > 0) notes.push('Imported people are not verified, so they will not get emails until they sign in themselves.');
  const next = offset + IMPORT_ROW_LIMIT < all.length ? offset + IMPORT_ROW_LIMIT : null;
  return { imported, skipped, notes, next };
}

const CSV_COLUMNS = ['title', 'body', 'board', 'status', 'votes', 'comments', 'author_name', 'author_email', 'tags', 'created_at', 'url_slug'];

export async function postsCsv(ctx: Ctx): Promise<string> {
  const rows = await ctx.db.all<Record<string, unknown>>(
    `SELECT p.title, p.body, b.name AS board, s.name AS status, p.vote_count AS votes, p.comment_count AS comments,
            pe.name AS author_name, pe.email AS author_email,
            (SELECT GROUP_CONCAT(t.name, ';') FROM fb_post_tags pt JOIN fb_tags t ON t.id = pt.tag_id WHERE pt.post_id = p.id) AS tags,
            strftime('%Y-%m-%dT%H:%M:%SZ', p.created_at / 1000, 'unixepoch') AS created_at, p.slug AS url_slug
       FROM fb_posts p JOIN fb_boards b ON b.id = p.board_id LEFT JOIN fb_statuses s ON s.id = p.status_id LEFT JOIN fb_people pe ON pe.id = p.author_id
      WHERE p.org_id = :org AND p.review = 'published' ORDER BY p.created_at DESC LIMIT 50000`,
  );
  return toCsv(rows, { columns: CSV_COLUMNS, bom: true });
}

export const EXPORT_TABLES = ['fb_portals', 'fb_boards', 'fb_categories', 'fb_statuses', 'fb_tags', 'fb_people', 'fb_posts', 'fb_post_tags', 'fb_votes', 'fb_comments', 'fb_notes', 'fb_status_log', 'fb_entries', 'fb_entry_posts', 'fb_images', 'fb_subscribers'];

export async function exportAll(ctx: Ctx): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const table of EXPORT_TABLES) {
    out[table] = await ctx.db.all(`SELECT * FROM ${table} WHERE org_id = :org LIMIT 100000`);
  }
  return out;
}
