/** Everything the Updates screen reads. Only facts this install can know about itself. */
import pkg from '../../../package.json';
import { emailStatus, type EmailSetup } from '../../core/email';
import { listJobFailures, type JobFailure } from '../../core/jobs';
import { allModules } from '../../core/registry';
import { migrations as shippedMigrations } from '../../generated/migrations';
import type { Env } from '../../env';

/** Failed jobs shown at once. */
export const FAILURES_PAGE_SIZE = 25;
/** Applied database changes read. Far more than a real install ever has; past this, newer ones would wrongly show as waiting. */
const MIGRATION_LIMIT = 2000;

export interface AppliedMigration {
  name: string;
  /** ms since 1970, or null when the stored time could not be read. */
  at: number | null;
}

export interface InstalledModule {
  id: string;
  name: string;
  version: string;
  category: string;
}

export interface UpdatesPage {
  version: string;
  /** Null when this database keeps no list (Cloudflare D1 does; a bare SQLite file does not). */
  migrations: AppliedMigration[] | null;
  /** Changes this code expects that the database does not have yet, in the order they will be applied. */
  waiting: string[];
  /** Changes the database has that this code does not know, which happens after going back a version. */
  unknown: string[];
  modules: InstalledModule[];
  email: EmailSetup;
  failures: JobFailure[];
  /** Pass this as `before` to read older failures, or null at the end of the list. */
  nextBefore: number | null;
}

/** The version in package.json, which is the version of the code that is running. */
export function runningVersion(): string {
  return pkg.version;
}

/** `?before=<ms>` from the address bar. Anything else starts again at the newest failure. */
export function readBefore(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  return Number(value);
}

/** Wrangler records each applied file in `d1_migrations`, with a UTC time like "2026-11-20 09:30:00". */
async function appliedMigrations(env: Env): Promise<AppliedMigration[] | null> {
  try {
    const { results } = await env.DB.prepare(`SELECT name, applied_at FROM d1_migrations ORDER BY id LIMIT ${MIGRATION_LIMIT}`).all<{
      name: string;
      applied_at: string | null;
    }>();
    return results.map((r) => {
      const at = r.applied_at ? Date.parse(`${r.applied_at.replace(' ', 'T')}Z`) : NaN;
      return { name: r.name, at: Number.isFinite(at) ? at : null };
    });
  } catch {
    return null;
  }
}

/**
 * Sets the changes the code ships against the ones the database recorded. Names are compared without
 * the `.sql` ending, since Wrangler has stored them both ways over time.
 */
export function compareMigrations(shipped: readonly string[], applied: readonly string[]): { waiting: string[]; unknown: string[] } {
  const key = (name: string) => name.replace(/\.sql$/i, '');
  const have = new Set(applied.map(key));
  const want = new Set(shipped.map(key));
  return { waiting: shipped.filter((n) => !have.has(key(n))), unknown: applied.filter((n) => !want.has(key(n))) };
}

export async function loadUpdatesPage(
  env: Env,
  opts: { before?: number | undefined; /** For tests: the changes the code ships. */ shipped?: readonly string[] } = {},
): Promise<UpdatesPage> {
  const [migrations, email, rows] = await Promise.all([
    appliedMigrations(env),
    emailStatus(env),
    listJobFailures(env, { limit: FAILURES_PAGE_SIZE + 1, ...(opts.before !== undefined ? { before: opts.before } : {}) }),
  ]);
  const failures = rows.slice(0, FAILURES_PAGE_SIZE);
  const last = failures[failures.length - 1];
  // No list to compare with means nothing can be called waiting.
  const { waiting, unknown } = migrations
    ? compareMigrations(opts.shipped ?? shippedMigrations, migrations.map((m) => m.name))
    : { waiting: [], unknown: [] };
  return {
    version: runningVersion(),
    migrations,
    waiting,
    unknown,
    modules: allModules().map((m) => ({ id: m.id, name: m.name, version: m.version, category: m.category })),
    email,
    failures,
    nextBefore: rows.length > FAILURES_PAGE_SIZE && last ? last.failedAt : null,
  };
}
