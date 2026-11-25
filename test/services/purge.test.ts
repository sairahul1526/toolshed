/**
 * Deleting a workspace takes everything it stored and nothing of anybody else's: rows in every
 * core table, the module tables, and the export files in the bucket.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eraseWorkspace } from '../../src/auth/workspace-store';
import { audit } from '../../src/core/audit';
import { exportKey } from '../../src/core/export';
import { defineModule } from '../../src/core/module';
import { isSuppressed, suppressAddress } from '../../src/core/email';
import { cleanupJobs, listJobFailures, recordJobFailure } from '../../src/core/jobs';
import { CORE_ORG_TABLES, ORG_TABLES_KEPT, purgeOrgData, registerModules, setModuleEnabled } from '../../src/core/registry';
import { modules as shippedModules } from '../../src/generated/modules';
import { setSetting } from '../../src/core/settings';
import { createTestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

afterEach(() => registerModules([]));

const GONE = 'org_gone';
const KEPT = 'org_kept';

/** Every table that holds a workspace's rows, with the column that names the workspace. */
const TABLES: Array<[table: string, column: string]> = [
  ['notes_items', 'org_id'],
  ['module_state', 'org_id'],
  ['audit_log', 'org_id'],
  ['api_keys', 'org_id'],
  ['service_accounts', 'org_id'],
  ['notifications', 'org_id'],
  ['notification_marks', 'org_id'],
  ['notification_reads', 'org_id'],
  ['exports', 'org_id'],
  ['job_failures', 'org_id'],
  ['email_suppressions', 'org_id'],
  ['settings', 'scope'],
];

function setup(): TestEnv {
  const t = createTestEnv();
  registerModules([defineModule({ id: 'notes', name: 'Notes', description: 'Notes', icon: 'file', category: 'growth', version: '0.1.0', tables: ['notes_items'] })]);
  t.sqlite.exec('CREATE TABLE notes_items (id TEXT PRIMARY KEY, org_id TEXT NOT NULL)');
  return t;
}

/** One row in every table, and one export file, for a workspace. */
async function seed(t: TestEnv, org: string): Promise<void> {
  const run = (sql: string, ...binds: Array<string | null>) => t.sqlite.prepare(sql).run(...binds);
  run('INSERT INTO notes_items (id, org_id) VALUES (?, ?)', `note_${org}`, org);
  await setModuleEnabled(t.env, org, 'notes', true);
  await audit(t.env, { orgId: org, actorType: 'system', action: 'test.seeded', summary: 'Seeded' });
  run(
    `INSERT INTO service_accounts (id, org_id, name, role, created_by, created_at) VALUES (?, ?, 'Deploy bot', 'admin', 'usr_1', 1)`,
    `sa_${org}`,
    org,
  );
  for (const [id, kind, user, account] of [[`key_p_${org}`, 'personal', 'usr_1', null], [`key_s_${org}`, 'service', null, `sa_${org}`]] as const) {
    run(
      `INSERT INTO api_keys (id, org_id, name, kind, user_id, service_account_id, prefix, key_hash, scopes, role, created_by, created_at)
       VALUES (?, ?, 'CI', ?, ?, ?, ?, 'hash', '["*"]', 'admin', 'usr_1', 1)`,
      id, org, kind, user, account, `ts_live_${id}`,
    );
  }
  run(`INSERT INTO notifications (id, org_id, title, created_at) VALUES (?, ?, 'Hello', 1)`, `ntf_${org}`, org);
  run('INSERT INTO notification_marks (org_id, user_id, read_all_at) VALUES (?, ?, 1)', org, 'usr_1');
  run('INSERT INTO notification_reads (org_id, user_id, notification_id, read_at) VALUES (?, ?, ?, 1)', org, 'usr_1', `ntf_${org}`);
  run(`INSERT INTO exports (id, org_id, requested_by, status, created_at) VALUES (?, ?, 'usr_1', 'ready', 1)`, `exp_${org}`, org);
  await t.env.FILES.put(exportKey(org, `exp_${org}`), 'zip');
  // Modules keep their files under <module id>/<workspace id>/.
  await t.env.FILES.put(`notes/${org}/attachments/a.png`, 'png');
  await setSetting(t.env, org, 'timezone', 'Europe/Paris');
  await recordJobFailure(t.env, { name: 'notes.sync', payload: { orgId: org, note: `note_${org}` } }, new Error('Timed out'), 3);
  await suppressAddress(t.env, `bounced@${org}.example.com`, 'Hard bounce', org);
}

function left(t: TestEnv, org: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [table, column] of TABLES) {
    out[table] = Number((t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(org) as { n: number }).n);
  }
  return out;
}

const files = async (t: TestEnv): Promise<string[]> => (await t.env.FILES.list()).objects.map((o) => o.key);
const nothing = Object.fromEntries(TABLES.map(([table]) => [table, 0]));

describe('purging a workspace', () => {
  it('takes its keys, service accounts, notifications, exports and files, and only its own', async () => {
    const t = setup();
    await seed(t, GONE);
    await seed(t, KEPT);
    // A workspace whose id starts the same way is a different workspace.
    await t.env.FILES.put(exportKey(`${GONE}_2`, 'exp_x'), 'zip');
    await t.env.FILES.put(`notes/${GONE}_2/a.png`, 'png');
    const before = left(t, KEPT);
    expect(Object.values(left(t, GONE)).every((n) => n > 0)).toBe(true);

    await purgeOrgData(t.env, GONE);

    expect(left(t, GONE)).toEqual(nothing);
    expect(left(t, KEPT)).toEqual(before);
    expect(await files(t)).toEqual(
      [exportKey(`${GONE}_2`, 'exp_x'), exportKey(KEPT, `exp_${KEPT}`), `notes/${GONE}_2/a.png`, `notes/${KEPT}/attachments/a.png`].sort(),
    );
  });

  it('is safe to run twice', async () => {
    const t = setup();
    await seed(t, GONE);
    await purgeOrgData(t.env, GONE);
    await purgeOrgData(t.env, GONE);
    expect(left(t, GONE)).toEqual(nothing);
  });
});

describe('deleting a workspace', () => {
  it('removes the stored data and the members in one step, or nothing at all', async () => {
    const t = setup();
    await createTestSession(t.env, { email: 'ada@example.com', role: 'owner', orgId: GONE });
    await seed(t, GONE);
    const before = left(t, GONE);
    const members = () => Number((t.sqlite.prepare('SELECT COUNT(*) AS n FROM "member" WHERE "organizationId" = ?').get(GONE) as { n: number }).n);

    // The last statements of the delete fail: nothing before them may have happened either,
    // or a member could keep writing into a workspace whose data is already gone.
    t.sqlite.exec('ALTER TABLE "invitation" RENAME TO "invitation_away"');
    await expect(eraseWorkspace(t.env, GONE)).rejects.toThrow();
    expect(left(t, GONE)).toEqual(before);
    expect(members()).toBe(1);

    t.sqlite.exec('ALTER TABLE "invitation_away" RENAME TO "invitation"');
    await eraseWorkspace(t.env, GONE);
    expect(left(t, GONE)).toEqual(nothing);
    expect(members()).toBe(0);
    expect(await files(t)).toEqual([]);
  });
});

describe('what a deleted workspace leaves behind', () => {
  it('drops its failed jobs and keeps the ones that belong to the install', async () => {
    const t = setup();
    await seed(t, GONE);
    await recordJobFailure(t.env, { name: 'core.cleanup', payload: { day: 1 } }, new Error('Boom'), 3);

    await purgeOrgData(t.env, GONE);

    const items = await listJobFailures(t.env);
    expect(items.map((f) => f.name)).toEqual(['core.cleanup']);
  });

  it('clears, at the daily cleanup, a failure recorded after the workspace was deleted', async () => {
    const t = setup();
    await createTestSession(t.env, { email: 'ada@example.com', role: 'owner', orgId: KEPT });
    // The job was on the queue when its workspace went, and ran out of retries afterwards.
    await recordJobFailure(t.env, { name: 'notes.sync', payload: { orgId: GONE } }, new Error('No such workspace'), 5);
    await recordJobFailure(t.env, { name: 'notes.sync', payload: { orgId: KEPT } }, new Error('Timed out'), 5);
    await recordJobFailure(t.env, { name: 'core.cleanup', payload: { day: 1 } }, new Error('Boom'), 5);

    await cleanupJobs(t.env);

    const left = t.sqlite.prepare('SELECT org_id FROM job_failures ORDER BY org_id').all().map((r) => (r as { org_id: string }).org_id);
    expect(left).toEqual(['', KEPT]);
  });

  it('keeps bounced addresses blocked, without the name of the workspace', async () => {
    const t = setup();
    await seed(t, GONE);
    await seed(t, KEPT);

    await purgeOrgData(t.env, GONE);

    expect(await isSuppressed(t.env, `bounced@${GONE}.example.com`)).toBe(true);
    const rows = t.sqlite.prepare('SELECT address, org_id FROM email_suppressions ORDER BY address').all();
    expect(rows.map((r) => ({ ...r }))).toEqual([
      { address: `bounced@${GONE}.example.com`, org_id: '' },
      { address: `bounced@${KEPT}.example.com`, org_id: KEPT },
    ]);
  });

  it('covers every table that has an org_id column', () => {
    const t = createTestEnv();
    const names = (t.sqlite.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map((r) => r.name);
    const withOrg = names.filter((name) => (t.sqlite.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]).some((c) => c.name === 'org_id'));
    const covered = new Set<string>([...CORE_ORG_TABLES, ...Object.keys(ORG_TABLES_KEPT), ...shippedModules.flatMap((m) => m.tables ?? [])]);

    expect(withOrg.length).toBeGreaterThan(CORE_ORG_TABLES.length);
    expect(withOrg.filter((name) => !covered.has(name))).toEqual([]);
    // A table cannot be both emptied and kept.
    expect(CORE_ORG_TABLES.filter((name) => name in ORG_TABLES_KEPT)).toEqual([]);
  });
});
