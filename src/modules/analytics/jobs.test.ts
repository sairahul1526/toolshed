import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestEnv } from '../../../test/helpers/d1';
import { orgDb } from '../../core/db';
import { devOutbox } from '../../core/email';
import type { ModuleContext } from '../../core/module';
import { registerModules } from '../../core/registry';
import { exportData } from './export';
import { alertJob, checkSpike, emitGoals, hourlyJob, pruneJob, reportJob, reportKey, SPIKE_QUIET_MS, triggerReport } from './jobs';
import analytics, { TABLES } from './module';
import { rollupSite } from './rollup';
import { clearSampleData, sampleData } from './sample';
import { createGoal, createShare, createSite, deleteSite, listGoals, updateSite, type Site } from './sites';
import { live, report, resolveRange } from './stats';
import { makeKit, type Kit } from './testkit';
import { DAY, HOUR, MINUTE } from './time';

/** Thursday 12 March 2026, 09:00 UTC. */
const T0 = Date.UTC(2026, 2, 12, 9, 0, 0);
/** The Monday of that week, and the one after. */
const MON = Date.UTC(2026, 2, 9);
const NEXT_MON = Date.UTC(2026, 2, 16);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

interface EventRow {
  name: string;
  subject: string;
  data: Record<string, unknown>;
}

function events(k: Kit, name: string): EventRow[] {
  const rows = k.t.sqlite.prepare("SELECT name, subject, data FROM events_recent WHERE module = 'analytics' AND name = ? ORDER BY at, id").all(name) as { name: string; subject: string; data: string }[];
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
}

function rows(k: Kit, table: string, siteId = k.site.id): number {
  return (k.t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE site_id = ?`).get(siteId) as { n: number }).n;
}

function queued(k: Kit): { name: string; payload: Record<string, unknown> }[] {
  return k.t.queue.sent.map((m) => m.body as { name: string; payload: Record<string, unknown> });
}

/** Tests save email to the outbox. This makes the install one that cannot send at all. */
function setEnvironment(k: Kit, value: string): void {
  (k.t.env as { ENVIRONMENT?: string }).ENVIRONMENT = value;
}

describe('the hourly pass', () => {
  it('rolls up every site that has something new', async () => {
    const k = await makeKit({}, T0);
    await k.hit(T0 + MINUTE);
    await hourlyJob(k.t.env, {}, T0 + HOUR);
    expect((await k.fresh()).rolled_at).toBe(T0 + HOUR);
    expect(rows(k, 'an_rollups')).toBeGreaterThan(0);
    expect(queued(k)).toEqual([]);
  });

  it('looks after six sites a run and queues the next run from where it stopped', async () => {
    const k = await makeKit({}, T0);
    const ids = [k.site.id];
    for (let i = 1; i <= 7; i++) ids.push((await createSite(k.ctx, { domain: `site${i}.example.com` }, { now: T0 + i })).id);
    ids.sort();
    await hourlyJob(k.t.env, {}, T0 + HOUR);
    expect(queued(k)).toEqual([{ name: 'analytics.hourly', payload: { after: ids[5] } }]);
    vi.setSystemTime(T0 + HOUR);
    await k.t.drainJobs();
    const rolled = k.t.sqlite.prepare('SELECT rolled_at FROM an_sites').all() as { rolled_at: number }[];
    expect(rolled.map((r) => r.rolled_at)).toEqual(ids.map(() => T0 + HOUR));
  });

  it('leaves sample sites alone', async () => {
    const k = await makeKit({}, T0);
    await sampleData(k.ctx, T0);
    const sample = k.t.sqlite.prepare('SELECT id, rolled_at FROM an_sites WHERE sample = 1').get() as { id: string; rolled_at: number };
    await hourlyJob(k.t.env, {}, T0 + HOUR);
    expect((k.t.sqlite.prepare('SELECT rolled_at FROM an_sites WHERE id = ?').get(sample.id) as { rolled_at: number }).rolled_at).toBe(sample.rolled_at);
  });

  it('comes back to a site with a long backlog until it has caught up', async () => {
    const k = await makeKit({}, T0 - 6 * DAY);
    // Ten visits seven hours apart: more six-hour steps than one run takes.
    for (let i = 0; i < 10; i++) await k.hit(T0 - 5 * DAY + i * 7 * HOUR, { who: i + 1 });
    await hourlyJob(k.t.env, {}, T0);
    expect((await k.fresh()).rolled_at).toBeLessThan(T0);
    expect(queued(k)).toEqual([{ name: 'analytics.hourly', payload: { after: '', again: 1 } }]);
    await k.t.drainJobs();
    const site = await k.fresh();
    expect(site.rolled_at).toBe(T0);
    const res = await report(k.ctx.db, site, resolveRange(site, { period: '7d' }, T0), {}, { dims: [] });
    expect(res.totals).toMatchObject({ visitors: 10, pageviews: 10 });
  });
});

describe('goal.completed', () => {
  async function withGoal(): Promise<Kit> {
    const k = await makeKit({}, T0);
    await createGoal(k.ctx, k.site.id, { name: 'Signed up', kind: 'event', match: 'Signup' }, T0);
    return k;
  }

  it('sends one event for everything a goal gained since the last look', async () => {
    const k = await withGoal();
    await k.hit(T0 + MINUTE, { who: 1 });
    await k.hit(T0 + 2 * MINUTE, { who: 1, kind: 'e', name: 'Signup' });
    await k.hit(T0 + 3 * MINUTE, { who: 2, kind: 'e', name: 'Signup' });
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + HOUR)).toBe(1);
    expect(events(k, 'goal.completed').map((e) => e.data)).toEqual([
      expect.objectContaining({ siteId: k.site.id, domain: 'example.com', goal: 'Signed up', kind: 'event', match: 'Signup', completions: 2, day: '2026-03-12', dayTotal: 2 }),
    ]);
    // The day's total for the event counts completions, not events sent.
    expect(k.t.sqlite.prepare("SELECT count FROM event_counts WHERE module = 'analytics' AND name = 'goal.completed'").get()).toEqual({ count: 2 });

    // Nothing new: nothing sent.
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + HOUR + MINUTE)).toBe(0);

    await k.hit(T0 + HOUR + 5 * MINUTE, { who: 3, kind: 'e', name: 'Signup' });
    await rollupSite(k.t.env, await k.fresh(), T0 + 2 * HOUR);
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + 2 * HOUR)).toBe(1);
    expect(events(k, 'goal.completed')[1]!.data).toMatchObject({ completions: 1, dayTotal: 3 });
  });

  it('carries over what yesterday gained after its last look', async () => {
    const k = await withGoal();
    await k.hit(T0 + MINUTE, { who: 1, kind: 'e', name: 'Signup' });
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    await emitGoals(k.t.env, await k.fresh(), T0 + HOUR);
    const late = Date.UTC(2026, 2, 12, 23, 50);
    await k.hit(late, { who: 2, kind: 'e', name: 'Signup' });
    await k.hit(late + 20 * MINUTE, { who: 3, kind: 'e', name: 'Signup' });
    const next = Date.UTC(2026, 2, 13, 1, 0);
    await rollupSite(k.t.env, await k.fresh(), next);
    expect(await emitGoals(k.t.env, await k.fresh(), next)).toBe(1);
    expect(events(k, 'goal.completed')[1]!.data).toMatchObject({ completions: 2, day: '2026-03-13', dayTotal: 1 });
    expect(await emitGoals(k.t.env, await k.fresh(), next + HOUR)).toBe(0);
  });

  it('matches page goals with a star, and never sends more than five events for a site in one hour', async () => {
    const k = await makeKit({}, T0);
    for (let i = 0; i < 7; i++) await createGoal(k.ctx, k.site.id, { kind: 'page', match: i === 0 ? '/docs*' : `/p${i}` }, T0 + i);
    await k.hit(T0 + MINUTE, { url: 'https://example.com/docs/install' });
    await k.hit(T0 + 2 * MINUTE, { url: 'https://example.com/docs/api' });
    for (let i = 1; i < 7; i++) await k.hit(T0 + (2 + i) * MINUTE, { url: `https://example.com/p${i}` });
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + HOUR)).toBe(5);
    // The two that waited go out on the next look, and nothing is sent twice.
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + 2 * HOUR)).toBe(2);
    expect(await emitGoals(k.t.env, await k.fresh(), T0 + 3 * HOUR)).toBe(0);
    const sent = events(k, 'goal.completed');
    expect(new Set(sent.map((e) => e.subject)).size).toBe(7);
    expect(sent.find((e) => e.data.match === '/docs*')!.data.completions).toBe(2);
  });

  it('sends nothing when two runs look at the same moment', async () => {
    const k = await withGoal();
    await k.hit(T0 + MINUTE, { kind: 'e', name: 'Signup' });
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    const site = await k.fresh();
    const sent = await Promise.all([emitGoals(k.t.env, site, T0 + HOUR), emitGoals(k.t.env, site, T0 + HOUR)]);
    expect(sent[0] + sent[1]).toBe(1);
    expect(events(k, 'goal.completed')).toHaveLength(1);
  });
});

describe('traffic spikes', () => {
  async function busy(k: Kit, at: number, visitors: number, firstWho = 1): Promise<void> {
    for (let i = 0; i < visitors; i++) await k.hit(at + i * 1000, { who: firstWho + i });
  }

  it('tells the workspace once, then stays quiet for twelve hours', async () => {
    const k = await makeKit({}, T0);
    await updateSite(k.ctx, k.site.id, { spike_threshold: 3, report_emails: 'ana@example.com, ben@example.com' }, T0);
    await busy(k, T0 + MINUTE, 3);
    expect(await checkSpike(k.t.env, await k.fresh(), T0 + 10 * MINUTE)).toBe(false);
    await busy(k, T0 + 11 * MINUTE, 2, 4);
    const at = T0 + 20 * MINUTE;
    vi.setSystemTime(at);
    expect(await checkSpike(k.t.env, await k.fresh(), at)).toBe(true);
    expect((await k.fresh()).last_spike_at).toBe(at);
    expect(events(k, 'traffic.spike')).toEqual([{ name: 'traffic.spike', subject: k.site.id, data: { siteId: k.site.id, domain: 'example.com', visitors: 5, threshold: 3 } }]);
    expect(k.t.sqlite.prepare('SELECT title, body, href FROM notifications').all()).toEqual([
      { title: 'Traffic spike on example.com', body: '5 visitors in the last hour.', href: `/app/analytics/sites/${k.site.id}` },
    ]);

    await k.t.drainJobs();
    const mail = await devOutbox(k.t.env);
    expect(mail.map((m) => m.to).sort()).toEqual(['ana@example.com', 'ben@example.com']);
    expect(mail[0]!.subject).toBe('Traffic spike on example.com');
    expect(mail[0]!.text).toContain('5 people visited example.com in the last hour');
    expect(mail[0]!.text).toContain(`http://localhost/app/analytics/sites/${k.site.id}`);
    // The same job delivered twice does not email twice.
    await alertJob(k.t.env, { orgId: k.t.org.id, siteId: k.site.id, visitors: 5, index: 0 }, at);
    expect(await devOutbox(k.t.env)).toHaveLength(2);

    await busy(k, at + HOUR, 6, 20);
    expect(await checkSpike(k.t.env, await k.fresh(), at + HOUR + MINUTE)).toBe(false);
    await busy(k, at + SPIKE_QUIET_MS, 6, 40);
    expect(await checkSpike(k.t.env, await k.fresh(), at + SPIKE_QUIET_MS + MINUTE)).toBe(true);
    expect(events(k, 'traffic.spike')).toHaveLength(2);
  });

  it('is off until a threshold is set', async () => {
    const k = await makeKit({}, T0);
    await busy(k, T0 + MINUTE, 8);
    expect(await checkSpike(k.t.env, await k.fresh(), T0 + 10 * MINUTE)).toBe(false);
    expect(events(k, 'traffic.spike')).toEqual([]);
  });
});

describe('the weekly report', () => {
  it('is due from Monday 08:00 in the site’s own time zone', () => {
    const utc = { timezone: 'UTC' };
    expect(reportKey(utc, MON + 7 * HOUR + 59 * MINUTE)).toBeNull();
    expect(reportKey(utc, MON + 8 * HOUR)).toBe('2026-03-09');
    // A pass that was missed on Monday still sends later in the week.
    expect(reportKey(utc, T0)).toBe('2026-03-09');
    expect(reportKey(utc, NEXT_MON - HOUR)).toBe('2026-03-09');
    expect(reportKey(utc, NEXT_MON + HOUR)).toBeNull();

    // 08:00 in India is 02:30 UTC.
    const india = { timezone: 'Asia/Kolkata' };
    expect(reportKey(india, MON + 2 * HOUR + 29 * MINUTE)).toBeNull();
    expect(reportKey(india, MON + 2 * HOUR + 30 * MINUTE)).toBe('2026-03-09');
    // 08:00 in Los Angeles is 15:00 UTC that week, and 03:00 UTC on Monday is still Sunday evening there.
    const la = { timezone: 'America/Los_Angeles' };
    expect(reportKey(la, MON + 3 * HOUR)).toBe('2026-03-02');
    expect(reportKey(la, MON + 14 * HOUR + 59 * MINUTE)).toBeNull();
    expect(reportKey(la, MON + 15 * HOUR)).toBe('2026-03-09');
  });

  it('starts with the Monday after reports are turned on, then goes out once a week', async () => {
    const k = await makeKit({}, T0);
    expect(await triggerReport(k.t.env, await k.fresh(), T0)).toBe(false);
    await updateSite(k.ctx, k.site.id, { weekly_report: true, report_emails: ['ana@example.com'] }, T0);
    // Thursday: no report about a week nobody asked for.
    expect(await triggerReport(k.t.env, await k.fresh(), T0)).toBe(false);
    expect(queued(k)).toEqual([]);
    expect(await triggerReport(k.t.env, await k.fresh(), NEXT_MON + 7 * HOUR)).toBe(false);
    expect(await triggerReport(k.t.env, await k.fresh(), NEXT_MON + 8 * HOUR)).toBe(true);
    expect(queued(k)).toEqual([{ name: 'analytics.report', payload: { orgId: k.t.org.id, siteId: k.site.id, key: '2026-03-16', index: 0, sent: 0 } }]);
    expect(await triggerReport(k.t.env, await k.fresh(), NEXT_MON + 9 * HOUR)).toBe(false);
    expect(await triggerReport(k.t.env, await k.fresh(), NEXT_MON + 3 * DAY)).toBe(false);
    expect(queued(k)).toHaveLength(1);
  });

  it('emails the week before to each address and then says report.sent', async () => {
    const k = await makeKit({}, MON);
    await updateSite(k.ctx, k.site.id, { weekly_report: true, report_emails: 'ana@example.com\nben@example.com' }, MON);
    await k.hit(T0, { who: 1, referrer: 'https://www.google.com/' });
    await k.hit(T0 + MINUTE, { who: 1, url: 'https://example.com/pricing' });
    await k.hit(T0 + DAY, { who: 2 });
    const due = NEXT_MON + 8 * HOUR;
    vi.setSystemTime(due);
    await hourlyJob(k.t.env, {}, due);
    // Turned on mid-week, so the first pass on Monday only marks the week. Clear the mark to stand for "last week's went out".
    k.t.sqlite.prepare("UPDATE an_sites SET last_report_key = '2026-03-09'").run();
    k.t.queue.sent.length = 0;
    await hourlyJob(k.t.env, {}, due);
    expect(queued(k).map((j) => j.name)).toEqual(['analytics.report']);
    await k.t.drainJobs();

    const mail = await devOutbox(k.t.env);
    expect(mail.map((m) => m.to).sort()).toEqual(['ana@example.com', 'ben@example.com']);
    const text = mail[0]!.text ?? '';
    expect(mail[0]!.subject).toBe('example.com: your week in numbers');
    expect(text).toContain('9 Mar 2026 to 15 Mar 2026');
    expect(text).toContain('Visitors: 2 (none the week before)');
    expect(text).toContain('Page views: 3');
    expect(text).toContain('Top pages: / (2), /pricing (1)');
    expect(text).toContain('Top sources: Google (1), Direct / None (1)');
    expect(text).toContain(`http://localhost/app/analytics/sites/${k.site.id}?from=2026-03-09&to=2026-03-15`);
    expect(events(k, 'report.sent')).toEqual([{ name: 'report.sent', subject: k.site.id, data: { siteId: k.site.id, domain: 'example.com', week: '2026-03-16', recipients: 2 } }]);

    // A second delivery of the same job sends nothing more.
    await reportJob(k.t.env, { orgId: k.t.org.id, siteId: k.site.id, key: '2026-03-16', index: 0, sent: 0 }, due);
    await k.t.drainJobs();
    expect(await devOutbox(k.t.env)).toHaveLength(2);
    expect(events(k, 'report.sent')).toHaveLength(1);
  });

  it('says nothing when no email could be sent, or reports were turned off meanwhile', async () => {
    const k = await makeKit({}, MON);
    await updateSite(k.ctx, k.site.id, { weekly_report: true, report_emails: 'ana@example.com' }, MON);
    const payload = { orgId: k.t.org.id, siteId: k.site.id, key: '2026-03-16', index: 0, sent: 0 };
    setEnvironment(k, 'production');
    await reportJob(k.t.env, payload, NEXT_MON + 8 * HOUR);
    expect(events(k, 'report.sent')).toEqual([]);
    setEnvironment(k, 'test');
    await updateSite(k.ctx, k.site.id, { weekly_report: false }, MON);
    await reportJob(k.t.env, { ...payload, key: '2026-03-23' }, NEXT_MON + 8 * DAY);
    // Only the refused one is on record: nothing went out for the week after.
    expect((await devOutbox(k.t.env)).map((m) => m.status)).toEqual(['not_configured']);
  });
});

describe('pruning and purging', () => {
  it('deletes raw hits past the retention window and keeps the daily totals', async () => {
    const k = await makeKit({}, T0 - 12 * DAY);
    await updateSite(k.ctx, k.site.id, { retention_days: 7 }, T0 - 12 * DAY);
    await k.hit(T0 - 10 * DAY, { who: 1 });
    await k.hit(T0 - DAY, { who: 2 });
    await k.hit(T0 - HOUR, { who: 3 });
    await rollupSite(k.t.env, await k.fresh(), T0);
    expect((await k.fresh()).rolled_at).toBe(T0);
    await pruneJob(k.t.env, {}, T0);
    expect(rows(k, 'an_hits')).toBe(2);
    // The visitor rows of two days ago and older go too.
    expect((k.t.sqlite.prepare('SELECT COUNT(*) AS n FROM an_sessions WHERE day < ?').get('2026-03-10') as { n: number }).n).toBe(0);
    const site = await k.fresh();
    const res = await report(k.ctx.db, site, resolveRange(site, { period: '30d' }, T0), {}, { dims: ['page'] });
    expect(res.totals).toMatchObject({ visitors: 3, pageviews: 3 });
  });

  it('never deletes a hit that has not been added to the totals yet', async () => {
    const k = await makeKit({}, T0 - 12 * DAY);
    await updateSite(k.ctx, k.site.id, { retention_days: 7 }, T0 - 12 * DAY);
    await k.hit(T0 - 10 * DAY);
    await pruneJob(k.t.env, {}, T0);
    expect(rows(k, 'an_hits')).toBe(1);
  });

  it('walks every site three at a time', async () => {
    const k = await makeKit({}, T0);
    const ids = [k.site.id];
    for (let i = 1; i <= 4; i++) ids.push((await createSite(k.ctx, { domain: `site${i}.example.com` }, { now: T0 + i })).id);
    ids.sort();
    await pruneJob(k.t.env, {}, T0 + DAY);
    expect(queued(k)).toEqual([{ name: 'analytics.prune', payload: { after: ids[2] } }]);
    await k.t.drainJobs();
    expect(queued(k)).toEqual([]);
  });

  it('removes everything a deleted site left behind', async () => {
    const k = await makeKit({}, T0);
    const other = await createSite(k.ctx, { domain: 'kept.example.com' }, { now: T0 });
    await createGoal(k.ctx, k.site.id, { kind: 'page', match: '/thanks' }, T0);
    await createShare(k.ctx, k.site.id, {}, T0);
    await k.hit(T0 + MINUTE);
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    k.t.sqlite.prepare("INSERT INTO an_rollups (org_id, site_id, dim, day, value, visitors) VALUES (?, ?, 'page', '2026-03-12', '/', 1)").run(k.t.org.id, other.id);
    await deleteSite(k.ctx, k.site.id);
    expect(queued(k)).toEqual([{ name: 'analytics.purge', payload: { orgId: k.t.org.id, siteId: k.site.id } }]);
    await k.t.drainJobs();
    for (const table of TABLES.filter((t) => t !== 'an_sites')) expect(rows(k, table), table).toBe(0);
    expect(rows(k, 'an_rollups', other.id)).toBe(1);
  });
});

describe('sample data, export and the module card', () => {
  it('fills a sample site with a month of traffic, once, and removes all of it again', async () => {
    const k = await makeKit({}, T0);
    await sampleData(k.ctx, T0);
    await sampleData(k.ctx, T0);
    const samples = k.t.sqlite.prepare('SELECT * FROM an_sites WHERE sample = 1').all() as unknown as Site[];
    expect(samples).toHaveLength(1);
    const sample = samples[0]!;
    expect(rows(k, 'an_hits', sample.id)).toBeGreaterThan(1500);
    expect(rows(k, 'an_goals', sample.id)).toBe(2);
    // Sample sites say nothing to the rest of the app.
    expect(events(k, 'site.created').map((e) => e.subject)).toEqual([k.site.id]);

    const month = await report(k.ctx.db, sample, resolveRange(sample, { period: '30d' }, T0), {}, { dims: ['page', 'channel', 'country', 'device'], goals: await listGoals(k.ctx.db, sample.id) });
    expect(month.mode).toBe('totals');
    expect(month.totals.visitors).toBeGreaterThan(600);
    expect(month.totals.pageviews).toBeGreaterThan(month.totals.visits);
    expect(month.panels.page![0]!.value).toBe('/');
    expect(month.panels.channel!.map((r) => r.value)).toContain('AI assistants');
    expect(month.goals.map((g) => g.goal.name).sort()).toEqual(['Read the docs', 'Signed up']);
    expect(month.goals.every((g) => g.uniques > 0)).toBe(true);
    // The totals agree with a plain count over the stored hits.
    const brute = k.t.sqlite.prepare("SELECT COUNT(*) AS n FROM an_hits WHERE site_id = ? AND kind = 'p' AND day >= ?").get(sample.id, month.range.from) as { n: number };
    expect(month.totals.pageviews).toBe(brute.n);
    expect((await live(k.ctx.db, sample, T0)).visitors).toBeGreaterThanOrEqual(3);

    await clearSampleData(k.ctx);
    for (const table of TABLES.filter((t) => t !== 'an_sites')) expect(rows(k, table, sample.id), table).toBe(0);
    expect(k.t.sqlite.prepare('SELECT id FROM an_sites').all()).toEqual([{ id: k.site.id }]);
  });

  it('exports every table, without password hashes or another workspace’s rows', async () => {
    const k = await makeKit({}, T0);
    await createGoal(k.ctx, k.site.id, { kind: 'event', match: 'Signup' }, T0);
    await createShare(k.ctx, k.site.id, { password: 'open sesame' }, T0);
    await k.hit(T0 + MINUTE);
    await rollupSite(k.t.env, k.site, T0 + HOUR);
    const other: ModuleContext = { env: k.t.env, org: { id: 'org_other', name: 'Other', slug: 'other' }, db: orgDb(k.t.env.DB, 'org_other') };
    await createSite(other, { domain: 'example.org' }, { now: T0 });

    const out = await exportData(k.ctx);
    expect(Object.keys(out).sort()).toEqual([...TABLES].sort());
    expect(out.an_sites).toHaveLength(1);
    expect(out.an_hits).toHaveLength(1);
    expect(out.an_sessions).toHaveLength(1);
    expect(out.an_goals).toHaveLength(1);
    expect(out.an_rollups!.length).toBeGreaterThan(5);
    expect(out.an_shares).toEqual([expect.objectContaining({ has_password: true })]);
    const text = JSON.stringify(out);
    expect(text).not.toContain('password_hash');
    expect(text).not.toContain('org_other');
    expect(text).not.toContain('example.org');
  });

  it('asks for a first site, then shows today’s numbers on the overview', async () => {
    const t = createTestEnv();
    registerModules([analytics]);
    const ctx: ModuleContext = { env: t.env, org: t.org, db: orgDb(t.env.DB, t.org.id) };
    expect(await analytics.setup!(ctx)).toMatchObject({ status: 'needs_setup', action: { href: '/app/analytics/new' } });
    expect(await analytics.count!(ctx)).toBe(0);
    expect(await analytics.overview!(ctx)).toEqual([]);

    const k = await makeKit({}, T0 - DAY);
    await k.hit(T0 - 20 * HOUR, { who: 1 });
    await k.hit(T0 - HOUR, { who: 2 });
    await k.hit(T0 - 30 * MINUTE, { who: 3 });
    await k.hit(T0 - 20 * MINUTE, { who: 3, url: 'https://example.com/pricing' });
    await rollupSite(k.t.env, k.site, T0);
    expect(await analytics.setup!(k.ctx)).toEqual({ status: 'ready' });
    expect(await analytics.count!(k.ctx)).toBe(1);
    expect(await analytics.overview!(k.ctx)).toEqual([
      { label: 'Visitors today', value: '2', delta: '1 yesterday', href: '/app/analytics' },
      { label: 'Page views today', value: '3', href: '/app/analytics' },
    ]);
  });
});
