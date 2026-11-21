import { describe, expect, it } from 'vitest';
import {
  audit,
  auditFilters,
  exportAuditCsv,
  getAuditRetention,
  listAudit,
  purgeOldAudit,
  setAuditRetention,
} from '../../src/core/audit';
import { runSchedules } from '../../src/core/jobs';
import auditRoutes from '../../src/core/routes/audit';
import { createTestEnv, type TestEnv } from '../helpers/d1';
import { put, routeApp } from './helpers';

const DAY = 86_400_000;

/** Insert rows directly so each can have its own time. */
async function seed(t: TestEnv, rows: { id?: string; org?: string | null; actor?: string | null; label?: string | null; action?: string; target?: string | null; targetId?: string | null; summary?: string | null; at: number }[]) {
  const stmt = t.env.DB.prepare(
    `INSERT INTO audit_log (id, org_id, actor_id, actor_type, actor_label, action, target_type, target_id, summary, created_at)
     VALUES (?1, ?2, ?3, 'user', ?4, ?5, ?6, ?7, ?8, ?9)`,
  );
  let n = 0;
  for (const r of rows) {
    await stmt
      .bind(r.id ?? `aud_${String(n++).padStart(6, '0')}`, r.org === undefined ? t.org.id : r.org, r.actor ?? null, r.label ?? null, r.action ?? 'thing.done', r.target ?? null, r.targetId ?? null, r.summary ?? null, r.at)
      .run();
  }
}

async function protect(t: TestEnv) {
  // A workspace with a module_state row is a live workspace: its log is protected.
  await t.env.DB.prepare("INSERT INTO module_state (org_id, module_id, enabled) VALUES (?1, 'links', 1)").bind(t.org.id).run();
}

describe('listAudit', () => {
  it('filters by workspace, actor, action, target, text and time', async () => {
    const t = createTestEnv();
    const now = Date.UTC(2026, 10, 20);
    await seed(t, [
      { actor: 'usr_a', label: 'Maya', action: 'member.invited', target: 'member', targetId: 'inv_1', summary: 'Invited sam@example.com as Member', at: now - 5 * DAY },
      { actor: 'usr_b', label: 'Lee', action: 'apikey.created', target: 'apikey', targetId: 'key_9', summary: 'Created the key Zapier', at: now - 3 * DAY },
      { actor: 'usr_a', label: 'Maya', action: 'link.deleted', target: 'link', summary: 'Deleted 100% off', at: now - 1 * DAY },
      { org: 'org_other', actor: 'usr_z', action: 'member.invited', at: now - 1 * DAY },
      { org: null, actor: null, action: 'audit.retention_changed', at: now },
    ]);
    const ids = async (q: Parameters<typeof listAudit>[1]) => (await listAudit(t.env, { limit: 50, ...q })).items.map((i) => i.action);

    expect(await ids({ orgId: t.org.id })).toEqual(['link.deleted', 'apikey.created', 'member.invited']);
    expect(await ids({})).toHaveLength(5);
    expect(await ids({ orgId: t.org.id, actorId: 'usr_a' })).toEqual(['link.deleted', 'member.invited']);
    expect(await ids({ orgId: t.org.id, action: 'apikey.created' })).toEqual(['apikey.created']);
    expect(await ids({ orgId: t.org.id, targetType: 'link' })).toEqual(['link.deleted']);
    expect(await ids({ orgId: t.org.id, q: 'zapier' })).toEqual(['apikey.created']);
    expect(await ids({ orgId: t.org.id, q: 'maya' })).toHaveLength(2);
    expect(await ids({ orgId: t.org.id, q: 'key_9' })).toEqual(['apikey.created']);
    expect(await ids({ orgId: t.org.id, q: '100%' })).toEqual(['link.deleted']);
    expect(await ids({ orgId: t.org.id, q: '%' })).toEqual(['link.deleted']);
    expect(await ids({ orgId: t.org.id, from: now - 4 * DAY, to: now - 2 * DAY })).toEqual(['apikey.created']);
  });

  it('pages over 250 rows without repeats or gaps, even with equal times', async () => {
    const t = createTestEnv();
    const base = Date.UTC(2026, 10, 20);
    // Pairs share a timestamp, so ordering has to fall back to the id.
    await seed(t, Array.from({ length: 250 }, (_, i) => ({ at: base - Math.floor(i / 2) * 1000 })));
    const seen: string[] = [];
    let before: string | undefined;
    let pages = 0;
    do {
      const page = await listAudit(t.env, { limit: 100, ...(before ? { before } : {}) });
      seen.push(...page.items.map((i) => i.id));
      before = page.nextCursor ?? undefined;
      pages++;
    } while (before);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(250);
    expect(new Set(seen).size).toBe(250);
    const times = (await listAudit(t.env, { limit: 200 })).items.map((i) => i.at);
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('stays stable when new entries arrive between pages', async () => {
    const t = createTestEnv();
    const base = Date.UTC(2026, 10, 20);
    await seed(t, Array.from({ length: 30 }, (_, i) => ({ at: base - i * 1000 })));
    const first = await listAudit(t.env, { limit: 10 });
    await seed(t, Array.from({ length: 5 }, (_, i) => ({ id: `aud_new_${i}`, at: base + (i + 1) * 1000 })));
    const second = await listAudit(t.env, { limit: 10, before: first.nextCursor! });
    const third = await listAudit(t.env, { limit: 100, before: second.nextCursor! });
    const all = [...first.items, ...second.items, ...third.items].map((i) => i.id);
    expect(all).toHaveLength(30);
    expect(new Set(all).size).toBe(30);
    expect(all.some((id) => id.startsWith('aud_new_'))).toBe(false);
  });

  it('has no cursor on the last page and rejects a bad one', async () => {
    const t = createTestEnv();
    await seed(t, [{ at: 1 }, { at: 2 }]);
    expect((await listAudit(t.env, { limit: 2 })).nextCursor).toBeNull();
    expect((await listAudit(t.env, { limit: 1 })).nextCursor).not.toBeNull();
    await expect(listAudit(t.env, { before: '!!' })).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('returns parsed meta and the filter menus per workspace', async () => {
    const t = createTestEnv();
    await audit(t.env, { orgId: t.org.id, actorId: 'usr_a', actorLabel: 'Maya', action: 'x.done', meta: { n: 1 } });
    await audit(t.env, { orgId: 'org_other', actorId: 'usr_b', actorLabel: 'Lee', action: 'y.done' });
    expect((await listAudit(t.env, { orgId: t.org.id })).items[0]?.meta).toEqual({ n: 1 });
    expect(await auditFilters(t.env, t.org.id)).toEqual({ actions: ['x.done'], actors: [{ id: 'usr_a', label: 'Maya' }] });
    expect((await auditFilters(t.env)).actions).toEqual(['x.done', 'y.done']);
  });
});

describe('guard', () => {
  it('refuses edits and deletes of entries', async () => {
    const t = createTestEnv();
    await protect(t);
    await audit(t.env, { orgId: t.org.id, action: 'a.done' });
    await audit(t.env, { orgId: null, action: 'b.done' });
    await expect(t.env.DB.prepare("UPDATE audit_log SET summary = 'changed'").run()).rejects.toThrow(/cannot be edited/);
    await expect(t.env.DB.prepare('DELETE FROM audit_log WHERE org_id = ?1').bind(t.org.id).run()).rejects.toThrow(/cannot be deleted/);
    await expect(t.env.DB.prepare('DELETE FROM audit_log WHERE org_id IS NULL').run()).rejects.toThrow(/cannot be deleted/);
    await expect(t.env.DB.prepare('DELETE FROM audit_log').run()).rejects.toThrow(/cannot be deleted/);
    expect((await listAudit(t.env)).items).toHaveLength(2);
  });

  it('lets the workspace purge remove a deleted workspace’s log', async () => {
    const t = createTestEnv();
    await protect(t);
    await audit(t.env, { orgId: t.org.id, action: 'a.done' });
    await t.env.DB.prepare('DELETE FROM module_state WHERE org_id = ?1').bind(t.org.id).run();
    await t.env.DB.prepare('DELETE FROM audit_log WHERE org_id = ?1').bind(t.org.id).run();
    expect((await listAudit(t.env)).items).toHaveLength(0);
  });
});

describe('retention', () => {
  it('defaults to 90 days and accepts only the offered choices', async () => {
    const t = createTestEnv();
    expect(await getAuditRetention(t.env)).toBe(90);
    for (const days of [30, 180, 365, 'forever'] as const) {
      expect(await setAuditRetention(t.env, days, { id: 'usr_1' })).toBe(days);
      expect(await getAuditRetention(t.env)).toBe(days);
    }
    for (const bad of [0, 45, '90', null, undefined, 'never']) {
      await expect(setAuditRetention(t.env, bad)).rejects.toMatchObject({ code: 'validation_failed' });
    }
    expect(await getAuditRetention(t.env)).toBe('forever');
    const rows = await listAudit(t.env, { action: 'audit.retention_changed' });
    expect(rows.items).toHaveLength(4);
  });

  it('deletes only rows older than the choice, in every workspace, and keeps the guard shut', async () => {
    const t = createTestEnv();
    await protect(t);
    const now = Date.UTC(2026, 10, 21);
    await seed(t, [
      { id: 'old_a', at: now - 91 * DAY },
      { id: 'old_b', org: null, at: now - 400 * DAY },
      { id: 'old_c', org: 'org_other', at: now - 120 * DAY },
      { id: 'new_a', at: now - 89 * DAY },
      { id: 'new_b', at: now - 1 * DAY },
    ]);
    expect(await purgeOldAudit(t.env, now)).toBe(3);
    expect((await listAudit(t.env)).items.map((i) => i.id).sort()).toEqual(['new_a', 'new_b']);
    expect(await t.env.DB.prepare('SELECT purge_before FROM audit_guard').first()).toEqual({ purge_before: 0 });
    await expect(t.env.DB.prepare("DELETE FROM audit_log WHERE id = 'new_a'").run()).rejects.toThrow(/cannot be deleted/);

    await setAuditRetention(t.env, 30);
    expect(await purgeOldAudit(t.env, now)).toBe(1);
  });

  it('keeps everything when set to forever', async () => {
    const t = createTestEnv();
    await setAuditRetention(t.env, 'forever');
    await seed(t, [{ id: 'ancient', at: 1 }]);
    expect(await purgeOldAudit(t.env, Date.now())).toBe(0);
  });

  it('purges in bounded batches and continues on the next run', async () => {
    const t = createTestEnv();
    const now = Date.UTC(2026, 10, 21);
    await seed(t, Array.from({ length: 10_050 }, (_, i) => ({ at: now - 200 * DAY - i })));
    expect(await purgeOldAudit(t.env, now)).toBe(10_000);
    expect(await purgeOldAudit(t.env, now)).toBe(50);
  });

  it('runs every day as a core schedule', async () => {
    const t = createTestEnv();
    const at = new Date(Date.UTC(2026, 10, 22, 0, 0));
    await seed(t, [{ id: 'old', at: at.getTime() - 100 * DAY }, { id: 'new', at: at.getTime() - DAY }]);
    const res = await runSchedules(t.env, at);
    expect(res.ran).toContain('core.audit-retention');
    expect((await listAudit(t.env)).items.map((i) => i.id)).toEqual(['new']);
  });
});

describe('CSV export', () => {
  it('writes a header and one quoted row per entry, newest first, with a formula guard', async () => {
    const t = createTestEnv();
    await seed(t, [
      { actor: 'usr_a', label: 'Maya, "Boss"', action: 'a.done', target: 'link', targetId: 'lnk_1', summary: '=HYPERLINK("http://x")', at: Date.UTC(2026, 10, 19, 10, 30) },
      { actor: 'usr_b', label: 'Lee', action: 'b.done', summary: 'Plain', at: Date.UTC(2026, 10, 20, 8, 0) },
      { org: 'org_other', action: 'c.done', at: Date.UTC(2026, 10, 20, 9, 0) },
    ]);
    const csv = await exportAuditCsv(t.env, { orgId: t.org.id });
    const lines = csv.split('\r\n');
    expect(lines.pop()).toBe('');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('When (UTC),Workspace,Who,Kind,Action,What happened,Target type,Target,IP address');
    expect(lines[1]).toBe('2026-11-20T08:00:00.000Z,org_test,Lee,user,b.done,Plain,,,');
    expect(lines[2]).toBe(`2026-11-19T10:30:00.000Z,org_test,"Maya, ""Boss""",user,a.done,"'=HYPERLINK(""http://x"")",link,lnk_1,`);
    expect(csv).not.toContain('c.done');
  });

  it('caps the export at 10,000 rows', async () => {
    const t = createTestEnv();
    await seed(t, Array.from({ length: 10_020 }, (_, i) => ({ at: 1_700_000_000_000 + i })));
    const csv = await exportAuditCsv(t.env);
    expect(csv.split('\r\n').length).toBe(10_002);
  });
});

describe('routes', () => {
  async function setup() {
    const t = createTestEnv();
    await seed(t, [
      { actor: 'usr_a', label: 'Maya', action: 'member.invited', summary: 'Invited sam@example.com', at: 3000 },
      { actor: 'usr_b', label: 'Lee', action: 'link.deleted', at: 2000 },
      { org: 'org_other', action: 'secret.done', summary: 'Other workspace', at: 4000 },
      { org: null, action: 'install.done', at: 5000 },
    ]);
    return t;
  }

  it('shows a workspace admin only their workspace', async () => {
    const t = await setup();
    const api = routeApp(auditRoutes.api, t, { role: 'admin' });
    const res = await api.json('/');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { action: string }) => i.action)).toEqual(['member.invited', 'link.deleted']);
    expect(res.body.filters.actions).toEqual(['link.deleted', 'member.invited']);
    expect(res.body.nextCursor).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('secret.done');
  });

  it('applies filters and cursor from the query string', async () => {
    const t = await setup();
    const api = routeApp(auditRoutes.api, t);
    const q = await api.json('/?q=sam%40example');
    expect(q.body.items).toHaveLength(1);
    const first = await api.json('/?limit=1');
    expect(first.body.items).toHaveLength(1);
    const second = await api.json(`/?limit=1&before=${first.body.nextCursor}`);
    expect(second.body.items[0].action).toBe('link.deleted');
    expect(second.body.filters).toBeUndefined();
    expect((await api.json('/?limit=0')).status).toBe(422);
    expect((await api.json('/?from=abc')).status).toBe(422);
  });

  it('refuses members, viewers and a missing workspace', async () => {
    const t = await setup();
    for (const role of ['member', 'viewer'] as const) {
      const res = await routeApp(auditRoutes.api, t, { role }).json('/');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('forbidden');
    }
    expect((await routeApp(auditRoutes.api, t, { role: null }).json('/')).status).toBe(401);
  });

  it('lets only the instance owner read everything', async () => {
    const t = await setup();
    const admin = await routeApp(auditRoutes.api, t, { role: 'admin' }).json('/?scope=all');
    expect(admin.status).toBe(403);
    const owner = await routeApp(auditRoutes.api, t, { role: 'owner', isInstanceOwner: true }).json('/?scope=all');
    expect(owner.body.items.map((i: { action: string }) => i.action)).toEqual(['install.done', 'secret.done', 'member.invited', 'link.deleted']);
    // Without scope=all even the owner sees only the active workspace.
    const own = await routeApp(auditRoutes.api, t, { role: 'owner', isInstanceOwner: true }).json('/');
    expect(own.body.items).toHaveLength(2);
  });

  it('downloads the CSV with the same filters and safe headers', async () => {
    const t = await setup();
    const api = routeApp(auditRoutes.api, t);
    const res = await api.request('/export.csv?action=link.deleted');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text.split('\r\n').filter(Boolean)).toHaveLength(2);
    expect((await routeApp(auditRoutes.api, t, { role: 'member' }).json('/export.csv')).status).toBe(403);
  });

  it('reads retention for admins and changes it for the instance owner only', async () => {
    const t = await setup();
    const admin = routeApp(auditRoutes.api, t, { role: 'admin' });
    expect((await admin.json('/retention')).body).toEqual({ retention: 90, choices: [30, 90, 180, 365, 'forever'] });
    expect((await admin.json('/retention', put({ retention: 30 }))).status).toBe(403);
    const owner = routeApp(auditRoutes.api, t, { role: 'owner', isInstanceOwner: true });
    expect((await owner.json('/retention', put({ retention: 30 }))).body).toEqual({ retention: 30 });
    expect((await owner.json('/retention', put({ retention: 7 }))).status).toBe(422);
    expect(await getAuditRetention(t.env)).toBe(30);
  });
});
