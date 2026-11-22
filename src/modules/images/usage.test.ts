import { describe, expect, it } from 'vitest';
import { blogTemplate, mounted, type Mounted } from './test-support';
import { DAILY_KEEP_DAYS, dayOf, listLog, LOG_KEEP_DAYS, pruneUsage, recordFailure, recordHit, recordRender, rendersToday, rollupHits, topImages, usageSummary } from './usage';

const NOON = Date.UTC(2026, 2, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

function render(m: Mounted, templateId: string, hash: string, at: number, bytes = 1000) {
  return recordRender(m.t.env, { orgId: m.t.org.id, templateId, hash, format: 'svg', width: 1200, version: 1, query: `title=${hash}`, bytes, source: 'url', ms: 3 }, at);
}

function hit(m: Mounted, templateId: string, hash: string, at: number) {
  return recordHit(m.t.env, { orgId: m.t.org.id, templateId, hash, first: false }, at);
}

describe('usage', () => {
  it('counts new images and cache hits per day, with zeros for quiet days', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - 3 * DAY);
    await render(m, t.id, 'aaa', NOON - DAY, 1500);
    await render(m, t.id, 'bbb', NOON, 2500);
    for (let i = 0; i < 3; i++) await hit(m, t.id, 'aaa', NOON);
    await hit(m, t.id, 'bbb', NOON - DAY);

    const summary = await usageSummary(m.db, { days: 3, now: NOON });
    expect(summary.days).toEqual([
      { day: '2026-03-08', renders: 0, hits: 0, errors: 0, bytes: 0 },
      { day: '2026-03-09', renders: 1, hits: 1, errors: 0, bytes: 1500 },
      { day: '2026-03-10', renders: 1, hits: 3, errors: 0, bytes: 2500 },
    ]);
    expect(summary.totals).toEqual({ renders: 2, hits: 4, errors: 0, bytes: 4000 });
    expect(summary.today).toBe(1);
    expect(await rendersToday(m.db, NOON)).toBe(1);
    expect(await rendersToday(m.db, NOON + DAY)).toBe(0);
  });

  it('gives the same numbers before and after the hourly roll-up, and never counts a hit twice', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - DAY);
    await render(m, t.id, 'aaa', NOON);
    await render(m, t.id, 'bbb', NOON);
    for (let i = 0; i < 5; i++) await hit(m, t.id, 'aaa', NOON);
    await hit(m, t.id, 'bbb', NOON);
    const before = await usageSummary(m.db, { days: 2, now: NOON });

    await rollupHits(m.t.env, NOON + 1000);
    await rollupHits(m.t.env, NOON + 2000);
    expect(await usageSummary(m.db, { days: 2, now: NOON })).toEqual(before);
    expect((m.t.sqlite.prepare('SELECT COUNT(*) AS n FROM img_hits').get() as { n: number }).n).toBe(0);

    const top = await topImages(m.db);
    expect(top.map((image) => [image.query, image.hits])).toEqual([
      ['title=aaa', 5],
      ['title=bbb', 1],
    ]);
    expect(top[0]!.lastHitAt).toBe(NOON + 1000);

    await hit(m, t.id, 'aaa', NOON + 3000);
    expect((await usageSummary(m.db, { days: 1, now: NOON })).totals.hits).toBe(7);
  });

  it('can show one template on its own', async () => {
    const m = await mounted();
    const a = await blogTemplate(m, NOON - DAY);
    const b = await blogTemplate(m, NOON - DAY + 1);
    await render(m, a.id, 'aaa', NOON);
    await render(m, b.id, 'bbb', NOON);
    await render(m, b.id, 'ccc', NOON);
    await hit(m, b.id, 'bbb', NOON);
    expect((await usageSummary(m.db, { days: 1, now: NOON, templateId: a.id })).totals).toMatchObject({ renders: 1, hits: 0 });
    expect((await usageSummary(m.db, { days: 1, now: NOON, templateId: b.id })).totals).toMatchObject({ renders: 2, hits: 1 });
  });

  it('marks the first request for a template once', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - DAY);
    await recordHit(m.t.env, { orgId: m.t.org.id, templateId: t.id, hash: 'aaa', first: true }, NOON);
    await recordHit(m.t.env, { orgId: m.t.org.id, templateId: t.id, hash: 'aaa', first: true }, NOON + 5000);
    const row = m.t.sqlite.prepare('SELECT first_request_at FROM img_templates WHERE id = ?').get(t.id) as { first_request_at: number };
    expect(row.first_request_at).toBe(NOON);
  });

  it('logs failures and lists them on their own', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - DAY);
    await render(m, t.id, 'aaa', NOON);
    await recordFailure(m.t.env, { orgId: m.t.org.id, templateId: t.id, format: 'png', source: 'api', code: 'images.render_failed', detail: 'x'.repeat(1000) }, NOON + 1000);
    const all = await listLog(m.db);
    expect(all.items.map((entry) => entry.outcome)).toEqual(['error', 'rendered']);
    const failures = await listLog(m.db, { errorsOnly: true });
    expect(failures.items).toHaveLength(1);
    expect(failures.items[0]).toMatchObject({ code: 'images.render_failed', format: 'png', source: 'api', at: NOON + 1000 });
    expect(failures.items[0]!.detail).toHaveLength(300);
    expect((await usageSummary(m.db, { days: 1, now: NOON })).totals.errors).toBe(1);
  });

  it('pages through the log', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - DAY);
    for (let i = 0; i < 5; i++) await render(m, t.id, `h${i}`, NOON + i * 1000, 100 + i);
    const first = await listLog(m.db, { limit: 2 });
    const second = await listLog(m.db, { limit: 2, cursor: first.nextCursor });
    const third = await listLog(m.db, { limit: 2, cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map((entry) => entry.bytes)).toEqual([104, 103, 102, 101, 100]);
    expect(third.nextCursor).toBeNull();
  });

  it('drops old log lines and old daily totals', async () => {
    const m = await mounted();
    const t = await blogTemplate(m, NOON - 500 * DAY);
    await render(m, t.id, 'old', NOON - (DAILY_KEEP_DAYS + 5) * DAY);
    await render(m, t.id, 'mid', NOON - (LOG_KEEP_DAYS + 5) * DAY);
    await render(m, t.id, 'new', NOON - DAY);
    await pruneUsage(m.t.env, NOON);
    expect((await listLog(m.db)).items).toHaveLength(1);
    const days = m.t.sqlite.prepare('SELECT day FROM img_daily ORDER BY day').all() as { day: string }[];
    expect(days.map((row) => row.day)).toEqual([dayOf(NOON - (LOG_KEEP_DAYS + 5) * DAY), dayOf(NOON - DAY)]);
  });
});
