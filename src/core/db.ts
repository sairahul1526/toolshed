/**
 * Database helpers.
 *
 * Rules (see docs/architecture.md):
 * - Every module table has `org_id TEXT NOT NULL`. Inside a workspace, always go through `orgDb()`,
 *   which adds the workspace filter so a query cannot forget it.
 * - Public pages that start from a slug or code (no signed-in workspace) use `env.DB` directly to
 *   find the row, then switch to `orgDb(env.DB, row.org_id)`.
 * - Times are integer milliseconds since 1970 (`Date.now()`), in columns ending `_at`.
 * - Ids are text, made with `newId('prefix')`.
 */

export type Scalar = string | number | null;
export type Row = Record<string, unknown>;

const NAME = /^[a-z_][a-z0-9_]*$/;

function ident(name: string): string {
  if (!NAME.test(name)) throw new Error(`Unsafe SQL name: ${name}`);
  return name;
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/**
 * A sortable id such as `lnk_01jd3k8q2m7c4x9v0b5t6r`. The first 10 characters encode the time, so
 * ordering by id is ordering by creation time; the last 12 are random.
 */
export function newId(prefix: string, now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = '';
  for (const b of bytes) rand += ALPHABET[b % 32]!;
  return `${prefix}_${time}${rand}`;
}

/** A random URL-safe token, for secrets and codes that must not be guessable. */
export function randomToken(bytes = 24): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let s = '';
  for (const b of raw) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export interface ListOptions {
  where?: Record<string, Scalar>;
  /** Column name, optionally followed by ` DESC`. Defaults to `id DESC` (newest first). */
  orderBy?: string;
  limit?: number;
  offset?: number;
}

export interface OrgDb {
  readonly orgId: string;
  readonly d1: D1Database;
  /** Insert a row. `org_id` is added for you. Returns the stored row. */
  insert<T = Row>(table: string, row: Row): Promise<T>;
  /** One row by id, or null. */
  get<T = Row>(table: string, id: string): Promise<T | null>;
  /** First row matching every `where` column, or null. */
  findOne<T = Row>(table: string, where: Record<string, Scalar>): Promise<T | null>;
  list<T = Row>(table: string, opts?: ListOptions): Promise<T[]>;
  count(table: string, where?: Record<string, Scalar>): Promise<number>;
  /** Update columns of one row by id. Returns the new row, or null when it does not exist. */
  update<T = Row>(table: string, id: string, patch: Row): Promise<T | null>;
  /** Delete one row by id. Returns whether a row was deleted. */
  remove(table: string, id: string): Promise<boolean>;
  /**
   * Custom SQL. The text MUST contain `:org`, which is bound to this workspace's id, for example
   * `SELECT * FROM links WHERE org_id = :org AND clicks > ? ORDER BY clicks DESC`.
   * Other parameters use plain `?` in order. Do not put `?` or `:org` inside string literals.
   */
  all<T = Row>(sql: string, ...params: Scalar[]): Promise<T[]>;
  first<T = Row>(sql: string, ...params: Scalar[]): Promise<T | null>;
  run(sql: string, ...params: Scalar[]): Promise<{ changes: number }>;
}

function scoped(sql: string): string {
  if (!sql.includes(':org')) {
    throw new Error('orgDb query has no :org filter. Add "org_id = :org" or use env.DB for cross-workspace lookups.');
  }
  let n = 1;
  return sql.replace(/:org\b/g, '?1').replace(/\?(?!\d)/g, () => `?${++n}`);
}

function whereClause(where: Record<string, Scalar> | undefined, start: number): { sql: string; params: Scalar[] } {
  const parts: string[] = [];
  const params: Scalar[] = [];
  let n = start;
  for (const [col, value] of Object.entries(where ?? {})) {
    if (value === null) parts.push(`${ident(col)} IS NULL`);
    else {
      parts.push(`${ident(col)} = ?${n++}`);
      params.push(value);
    }
  }
  return { sql: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}

function orderClause(orderBy: string | undefined): string {
  if (!orderBy) return 'id DESC';
  return orderBy
    .split(',')
    .map((part) => {
      const [col, dir] = part.trim().split(/\s+/);
      const d = (dir ?? 'ASC').toUpperCase();
      if (d !== 'ASC' && d !== 'DESC') throw new Error(`Unsafe sort direction: ${dir}`);
      return `${ident(col ?? '')} ${d}`;
    })
    .join(', ');
}

function toBind(value: unknown): Scalar {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return JSON.stringify(value);
}

/** A database handle that only sees one workspace's rows. */
export function orgDb(d1: D1Database, orgId: string): OrgDb {
  if (!orgId) throw new Error('orgDb needs a workspace id');

  const db: OrgDb = {
    orgId,
    d1,

    async insert<T>(table: string, row: Row) {
      const full: Row = { ...row, org_id: orgId };
      const cols = Object.keys(full).map(ident);
      const sql = `INSERT INTO ${ident(table)} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')}) RETURNING *`;
      const stored = await d1
        .prepare(sql)
        .bind(...Object.values(full).map(toBind))
        .first<T>();
      return stored as T;
    },

    get<T>(table: string, id: string) {
      return d1.prepare(`SELECT * FROM ${ident(table)} WHERE org_id = ?1 AND id = ?2`).bind(orgId, id).first<T>();
    },

    findOne<T>(table: string, where: Record<string, Scalar>) {
      const w = whereClause(where, 2);
      return d1
        .prepare(`SELECT * FROM ${ident(table)} WHERE org_id = ?1${w.sql} LIMIT 1`)
        .bind(orgId, ...w.params)
        .first<T>();
    },

    async list<T>(table: string, opts: ListOptions = {}) {
      const w = whereClause(opts.where, 2);
      const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 1000);
      const offset = Math.max(0, Math.floor(opts.offset ?? 0));
      const sql = `SELECT * FROM ${ident(table)} WHERE org_id = ?1${w.sql} ORDER BY ${orderClause(opts.orderBy)} LIMIT ${limit} OFFSET ${offset}`;
      const { results } = await d1
        .prepare(sql)
        .bind(orgId, ...w.params)
        .all<T>();
      return results;
    },

    async count(table: string, where?: Record<string, Scalar>) {
      const w = whereClause(where, 2);
      const row = await d1
        .prepare(`SELECT COUNT(*) AS n FROM ${ident(table)} WHERE org_id = ?1${w.sql}`)
        .bind(orgId, ...w.params)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async update<T>(table: string, id: string, patch: Row) {
      const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'org_id');
      if (entries.length === 0) return db.get<T>(table, id);
      const sets = entries.map(([k], i) => `${ident(k)} = ?${i + 3}`).join(', ');
      return d1
        .prepare(`UPDATE ${ident(table)} SET ${sets} WHERE org_id = ?1 AND id = ?2 RETURNING *`)
        .bind(orgId, id, ...entries.map(([, v]) => toBind(v)))
        .first<T>();
    },

    async remove(table: string, id: string) {
      const res = await d1.prepare(`DELETE FROM ${ident(table)} WHERE org_id = ?1 AND id = ?2`).bind(orgId, id).run();
      return (res.meta.changes ?? 0) > 0;
    },

    async all<T>(sql: string, ...params: Scalar[]) {
      const { results } = await d1
        .prepare(scoped(sql))
        .bind(orgId, ...params)
        .all<T>();
      return results;
    },

    first<T>(sql: string, ...params: Scalar[]) {
      return d1
        .prepare(scoped(sql))
        .bind(orgId, ...params)
        .first<T>();
    },

    async run(sql: string, ...params: Scalar[]) {
      const res = await d1
        .prepare(scoped(sql))
        .bind(orgId, ...params)
        .run();
      return { changes: res.meta.changes ?? 0 };
    },
  };
  return db;
}
