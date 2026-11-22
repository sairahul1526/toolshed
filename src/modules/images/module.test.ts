import { describe, expect, it } from 'vitest';
import { orgDb } from '../../core/db';
import { moduleContext } from '../../core/registry';
import { createBatch, listBatches } from './batch';
import images from './module';
import { renderToStorage, bakePng } from './serve';
import { createTemplate, getTemplate, listTemplates } from './templates';
import { blogTemplate, mounted, tinyPng, type Mounted } from './test-support';
import { usageSummary } from './usage';

const BASE = 'http://localhost';
const FIRST = { attempt: 1 };

function ctxOf(m: Mounted) {
  return moduleContext(m.t.env, m.t.org);
}

function count(m: Mounted, table: string, where = '1 = 1'): number {
  return (m.t.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;
}

describe('the module definition', () => {
  it('says what it is, what it stores and what it runs', () => {
    expect(images.id).toBe('images');
    expect(images.publicPrefixes).toEqual(['/i']);
    expect(images.permissions?.map((p) => p.scope)).toEqual(['images:read', 'images:write']);
    expect(images.tables).toEqual(['img_templates', 'img_assets', 'img_renders', 'img_hits', 'img_log', 'img_daily', 'img_batches']);
    expect(Object.keys(images.jobs ?? {})).toEqual(['batch', 'purge']);
    expect(images.schedules?.map((s) => [s.name, s.every])).toEqual([
      ['images.rollup', 'hour'],
      ['images.prune', 'day'],
    ]);
    expect(images.events?.emits).toEqual(['template.created', 'template.updated', 'render.completed', 'batch.completed', 'quota.reached']);
  });

  it('is ready with nothing to configure, and counts templates', async () => {
    const m = await mounted();
    const ctx = await ctxOf(m);
    expect(await images.setup!(ctx)).toEqual({ status: 'ready' });
    expect(await images.count!(ctx)).toBe(0);
    await blogTemplate(m);
    expect(await images.count!(ctx)).toBe(1);
  });

  it('shows real zeros on the overview before anything is made', async () => {
    const m = await mounted();
    expect(await images.overview!(await ctxOf(m))).toEqual([
      { label: 'New images (30 days)', value: '0', href: '/app/images/usage' },
      { label: 'Images served from cache (30 days)', value: '0', href: '/app/images/usage' },
    ]);
  });
});

describe('sample data', () => {
  it('adds one published template and a week of usage, once', async () => {
    const m = await mounted();
    const ctx = await ctxOf(m);
    await images.sampleData!(ctx);
    await images.sampleData!(ctx);
    const { items } = await listTemplates(m.db);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: 'Blog post card (sample)', published: true });
    const usage = await usageSummary(m.db, { days: 8 });
    expect(usage.totals).toMatchObject({ renders: 36, hits: 906 });
    expect(usage.days.filter((day) => day.renders > 0)).toHaveLength(7);
    const overview = await images.overview!(ctx);
    expect(overview[0]!.value).toBe('36');
  });

  it('is removed without touching the workspace’s own templates', async () => {
    const m = await mounted();
    const ctx = await ctxOf(m);
    const mine = await blogTemplate(m);
    await images.sampleData!(ctx);
    const sample = (await listTemplates(m.db)).items.find((t) => t.id !== mine.id)!;
    await renderToStorage(m.t.env, m.db, sample.id, { format: 'svg', source: 'api', base: BASE });
    await renderToStorage(m.t.env, m.db, mine.id, { format: 'svg', source: 'api', base: BASE });
    expect(m.t.files.store.size).toBe(2);

    await images.clearSampleData!(ctx);
    expect(m.t.queue.sent.at(-1)!.body).toEqual({ name: 'images.purge', payload: { orgId: m.t.org.id, templateId: sample.id, keepBaked: false } });
    await m.t.drainJobs();

    expect((await listTemplates(m.db)).items.map((t) => t.id)).toEqual([mine.id]);
    expect(count(m, 'img_daily', `template_id = '${sample.id}'`)).toBe(0);
    expect(count(m, 'img_renders')).toBe(1);
    expect(m.t.files.store.size).toBe(1);
    expect((await usageSummary(m.db, { days: 8 })).totals.renders).toBe(1);
  });
});

describe('export', () => {
  it('returns every table, for this workspace only', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await renderToStorage(m.t.env, m.db, template.id, { format: 'svg', source: 'api', base: BASE });
    await createBatch(m.t.env, m.db, { templateId: template.id, rows: [{ title: 'One' }] }, BASE);
    const other = orgDb(m.t.env.DB, 'org_other');
    const theirs = await createTemplate(m.t.env, other, { starter: 'quote', publish: true });
    await renderToStorage(m.t.env, other, theirs.id, { format: 'svg', source: 'api', base: BASE });

    const data = await images.exportData!(await ctxOf(m));
    expect(Object.keys(data)).toEqual(images.tables);
    expect(data.img_templates).toHaveLength(1);
    expect(data.img_renders).toHaveLength(1);
    expect(data.img_log).toHaveLength(1);
    expect(data.img_daily).toHaveLength(1);
    expect(data.img_batches).toHaveLength(1);
    expect(data.img_assets).toEqual([]);
    for (const rows of Object.values(data)) for (const row of rows) expect((row as { org_id: string }).org_id).toBe(m.t.org.id);
  });
});

describe('removing stored images in the background', () => {
  it('keeps PNG files made in the browser when a template’s cache is cleared', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await renderToStorage(m.t.env, m.db, template.id, { values: { title: 'A' }, format: 'svg', source: 'api', base: BASE });
    await renderToStorage(m.t.env, m.db, template.id, { values: { title: 'B' }, format: 'svg', source: 'api', base: BASE });
    await bakePng(m.t.env, m.db, template.id, tinyPng(1200, 630), { base: BASE });
    expect(m.t.files.store.size).toBe(3);

    await images.jobs!.purge!(m.t.env, { orgId: m.t.org.id, templateId: template.id, keepBaked: true }, FIRST);
    expect([...m.t.files.store.keys()].map((key) => key.split('.').pop())).toEqual(['png']);
    expect(count(m, 'img_renders')).toBe(1);
    expect((await getTemplate(m.db, template.id)).id).toBe(template.id);
  });

  it('removes everything a deleted template left behind, and nothing of another template', async () => {
    const m = await mounted();
    const gone = await blogTemplate(m);
    const kept = await blogTemplate(m);
    await renderToStorage(m.t.env, m.db, gone.id, { format: 'svg', source: 'api', base: BASE });
    await bakePng(m.t.env, m.db, gone.id, tinyPng(1200, 630), { base: BASE });
    await renderToStorage(m.t.env, m.db, kept.id, { format: 'svg', source: 'api', base: BASE });
    const batch = await createBatch(m.t.env, m.db, { templateId: gone.id, rows: [{ title: 'One' }] }, BASE);
    await m.t.drainJobs();
    m.t.sqlite.prepare(`INSERT INTO img_hits (org_id, day, hash, template_id, hits) VALUES ('org_test', '2026-03-10', 'abc', ?, 3)`).run(gone.id);

    await images.jobs!.purge!(m.t.env, { orgId: m.t.org.id, templateId: gone.id, keepBaked: false }, FIRST);
    expect(count(m, 'img_renders', `template_id = '${gone.id}'`)).toBe(0);
    expect(count(m, 'img_renders', `template_id = '${kept.id}'`)).toBe(1);
    expect(count(m, 'img_hits')).toBe(0);
    expect((await listBatches(m.db)).items.map((b) => b.id)).not.toContain(batch.id);
    expect(m.t.files.store.size).toBe(1);

    // A second delivery of the same message finds nothing left to do.
    await images.jobs!.purge!(m.t.env, { orgId: m.t.org.id, templateId: gone.id, keepBaked: false }, FIRST);
    expect(m.t.files.store.size).toBe(1);
  });

  it('refuses a message it cannot read', async () => {
    const m = await mounted();
    await expect(images.jobs!.purge!(m.t.env, { templateId: 'x' }, FIRST)).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(images.jobs!.batch!(m.t.env, {}, FIRST)).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
