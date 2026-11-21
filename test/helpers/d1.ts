/**
 * Test doubles for the Cloudflare bindings, so unit tests run in plain Node with no workerd.
 *
 *   const t = createTestEnv();            // fresh in-memory database with every migration applied
 *   await something(t.env, t.org.id);
 *   await t.drainJobs();                  // run whatever was put on the jobs queue
 *
 * D1 is backed by Node's built-in SQLite, which is the same engine D1 uses.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { runJob } from '../../src/core/jobs';
import type { Env, JobMessage } from '../../src/env';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

type Bindable = string | number | bigint | null | Uint8Array;

function toSqlite(value: unknown): Bindable {
  if (value === undefined) throw new Error('D1_TYPE_ERROR: undefined is not a valid bind value');
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error(`D1_TYPE_ERROR: cannot bind ${typeof value}`);
}

const WRITE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

class TestStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: Bindable[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.db, this.sql, values.map(toSqlite));
  }

  execute() {
    const rows = this.db.prepare(this.sql).all(...this.params) as Record<string, unknown>[];
    const results = rows.map((r) => ({ ...r }));
    let changes = 0;
    let lastRowId = 0;
    if (WRITE.test(this.sql)) {
      const meta = this.db.prepare('SELECT changes() AS c, last_insert_rowid() AS id').get() as { c: number; id: number };
      changes = Number(meta.c);
      lastRowId = Number(meta.id);
    }
    return { success: true as const, results, meta: { changes, last_row_id: lastRowId, duration: 0, rows_read: 0, rows_written: changes } };
  }

  async first(column?: string): Promise<unknown> {
    const row = this.execute().results[0];
    if (!row) return null;
    return column ? (row[column] ?? null) : row;
  }

  async all() {
    return this.execute();
  }

  async run() {
    return this.execute();
  }

  async raw(): Promise<unknown[][]> {
    return this.execute().results.map((r) => Object.values(r));
  }
}

class TestD1 {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): TestStatement {
    return new TestStatement(this.sqlite, sql);
  }

  async batch(statements: TestStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.execute());
      this.sqlite.exec('COMMIT');
      return out;
    } catch (err) {
      this.sqlite.exec('ROLLBACK');
      throw err;
    }
  }

  async exec(sql: string) {
    this.sqlite.exec(sql);
    return { count: 1, duration: 0 };
  }
}

class TestKV {
  readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string, type?: 'text' | 'json' | { type?: 'text' | 'json' }): Promise<unknown> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (hit.expiresAt !== null && hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    const kind = typeof type === 'string' ? type : type?.type;
    return kind === 'json' ? JSON.parse(hit.value) : hit.value;
  }

  async put(key: string, value: string, opts: { expirationTtl?: number; expiration?: number } = {}): Promise<void> {
    const expiresAt = opts.expirationTtl ? Date.now() + opts.expirationTtl * 1000 : opts.expiration ? opts.expiration * 1000 : null;
    this.store.set(key, { value: String(value), expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(opts: { prefix?: string } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(opts.prefix ?? '')).sort();
    return { keys: keys.map((name) => ({ name })), list_complete: true, cacheStatus: null };
  }
}

class TestR2 {
  readonly store = new Map<string, { body: Uint8Array; httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }>();

  private view(key: string) {
    const obj = this.store.get(key);
    if (!obj) return null;
    const body = obj.body;
    return {
      key,
      size: body.byteLength,
      httpMetadata: obj.httpMetadata ?? {},
      customMetadata: obj.customMetadata ?? {},
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
      text: async () => new TextDecoder().decode(body),
      json: async () => JSON.parse(new TextDecoder().decode(body)),
      get body() {
        return new Blob([body]).stream();
      },
    };
  }

  async put(key: string, value: string | ArrayBuffer | Uint8Array, opts: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> } = {}) {
    const body = typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    this.store.set(key, { body, ...opts });
    return this.view(key);
  }

  async get(key: string) {
    return this.view(key);
  }

  async head(key: string) {
    return this.view(key);
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }

  async list(opts: { prefix?: string } = {}) {
    const objects = [...this.store.keys()]
      .filter((k) => k.startsWith(opts.prefix ?? ''))
      .sort()
      .map((k) => this.view(k)!);
    return { objects, truncated: false, delimitedPrefixes: [] };
  }
}

class TestQueue {
  readonly sent: { body: JobMessage; delaySeconds?: number }[] = [];

  async send(body: JobMessage, opts?: { delaySeconds?: number }) {
    this.sent.push({ body, ...(opts?.delaySeconds ? { delaySeconds: opts.delaySeconds } : {}) });
  }

  async sendBatch(messages: { body: JobMessage; delaySeconds?: number }[]) {
    for (const m of messages) await this.send(m.body, m);
  }
}

/** Every migration, in the order wrangler applies them: core first, then modules by id. */
export function migrationFiles(): string[] {
  const files: string[] = [];
  const add = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) files.push(join(dir, f));
  };
  add(join(root, 'src', 'core', 'migrations'));
  const modulesDir = join(root, 'src', 'modules');
  if (existsSync(modulesDir)) {
    for (const id of readdirSync(modulesDir).sort()) add(join(modulesDir, id, 'migrations'));
  }
  return files;
}

export interface TestEnv {
  env: Env;
  /** A ready-made workspace id to store rows under. */
  org: { id: string; name: string; slug: string };
  sqlite: DatabaseSync;
  kv: TestKV;
  files: TestR2;
  queue: TestQueue;
  /** Run every queued job (and any jobs those enqueue). Returns how many ran. */
  drainJobs(): Promise<number>;
}

export function createTestEnv(vars: Partial<Env> = {}): TestEnv {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of migrationFiles()) sqlite.exec(readFileSync(file, 'utf8'));
  const kv = new TestKV();
  const files = new TestR2();
  const queue = new TestQueue();
  const env = {
    DB: new TestD1(sqlite) as unknown as D1Database,
    KV: kv as unknown as KVNamespace,
    FILES: files as unknown as R2Bucket,
    JOBS: queue as unknown as Queue<JobMessage>,
    ASSETS: { fetch: async () => new Response('Not found', { status: 404 }) } as unknown as Fetcher,
    ENVIRONMENT: 'test',
    AUTH_SECRET: 'test-secret-test-secret-test-secret-0123456789',
    OWNER_EMAIL: 'owner@example.com',
    APP_URL: 'http://localhost',
    ...vars,
  } satisfies Env;

  return {
    env,
    org: { id: 'org_test', name: 'Test Workspace', slug: 'test' },
    sqlite,
    kv,
    files,
    queue,
    async drainJobs() {
      let ran = 0;
      while (queue.sent.length > 0) {
        const next = queue.sent.shift()!;
        await runJob(env, next.body);
        ran++;
      }
      return ran;
    },
  };
}
