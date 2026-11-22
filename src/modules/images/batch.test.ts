import { describe, expect, it } from 'vitest';
import { orgDb } from '../../core/db';
import { recentEvents } from '../../core/events';
import { batchCsv, createBatch, deleteBatch, getBatch, listBatches, MAX_BATCH_ROWS, runBatch, writeBatchZip } from './batch';
import { saveSettings } from './settings';
import { createTemplate } from './templates';
import { blogTemplate, mounted, pathOf, type Mounted } from './test-support';

const BASE = 'http://localhost';

function titles(n: number): { title: string }[] {
  return Array.from({ length: n }, (_, i) => ({ title: `Card ${i + 1}` }));
}

async function zipOf(m: Mounted, id: string): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  await writeBatchZip(m.t.env, m.db, await getBatch(m.db, id), async (chunk) => void chunks.push(chunk));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

describe('batches', () => {
  it('draws every row in the background, a few at a time, and says when it is done', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: titles(7) }, BASE, { id: 'usr_1' });
    expect(batch).toMatchObject({ status: 'queued', total: 7, done: 0, failed: 0, format: 'svg', name: 'Blog post, 7 images', results: [] });
    expect(m.t.queue.sent.map((job) => job.body)).toEqual([{ name: 'images.batch', payload: { orgId: m.t.org.id, batchId: batch.id } }]);

    // Seven SVG rows take two runs of five.
    expect(await m.t.drainJobs()).toBe(2);
    const done = await getBatch(m.db, batch.id);
    expect(done).toMatchObject({ status: 'done', done: 7, failed: 0 });
    expect(done.finishedAt).not.toBeNull();
    expect(done.results.map((r) => r.row)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    const first = await m.visitor.request(pathOf(done.results[0]!.url!));
    expect(first.status).toBe(200);
    expect(first.headers.get('x-images-cache')).toBe('hit');

    const events = await recentEvents(m.t.env, m.t.org.id, { module: 'images', limit: 50 });
    expect(events.filter((e) => e.name === 'render.completed')).toHaveLength(7);
    const finished = events.filter((e) => e.name === 'batch.completed');
    expect(finished).toHaveLength(1);
    expect(finished[0]!.data).toEqual({ id: batch.id, templateId: template.id, total: 7, done: 7, failed: 0 });
  });

  it('reads rows from CSV text, matching columns to fields whatever their case', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const csv = 'Title,SITE,notes\r\n"Hello, world",a.example.com,ignored\r\nSecond card,,\r\n';
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, csv, name: 'Spring posts' }, BASE);
    expect(batch).toMatchObject({ total: 2, name: 'Spring posts' });
    await m.t.drainJobs();
    const done = await getBatch(m.db, batch.id);
    expect(done.status).toBe('done');
    expect(done.results[0]!.url).toContain('title=Hello%2C+world&site=a.example.com');
    expect(done.results[1]!.url).toContain('title=Second+card');
  });

  it('refuses rows it cannot use, with a reason', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const draft = await createTemplate(m.t.env, m.db, { starter: 'quote' });
    const start = (input: Record<string, unknown>) => createBatch(m.t.env, m.db, input, BASE);
    await expect(start({ templateId: template.id, rows: [] })).rejects.toMatchObject({ code: 'images.batch_empty' });
    await expect(start({ templateId: template.id, csv: 'title\n' })).rejects.toMatchObject({ code: 'images.batch_empty' });
    await expect(start({ templateId: template.id })).rejects.toMatchObject({ code: 'images.batch_empty' });
    await expect(start({ templateId: template.id, rows: titles(MAX_BATCH_ROWS + 1) })).rejects.toMatchObject({ code: 'images.batch_too_large' });
    await expect(start({ templateId: template.id, csv: 'name,price\nA,1\n' })).rejects.toMatchObject({ code: 'validation_failed', fields: { csv: expect.stringContaining('title, site, author, accent') } });
    await expect(start({ templateId: template.id, rows: titles(1), format: 'gif' })).rejects.toMatchObject({ code: 'validation_failed' });
    await expect(start({ templateId: draft.id, rows: titles(1) })).rejects.toMatchObject({ code: 'images.not_published' });
    await expect(start({ templateId: 'imgt_missing', rows: titles(1) })).rejects.toMatchObject({ code: 'not_found' });
    expect(m.t.queue.sent).toEqual([]);
  });

  it('records why a row failed and carries on with the rest', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    await saveSettings(m.t.env, m.t.org.id, { dailyCap: 3 });
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: titles(6) }, BASE);
    await m.t.drainJobs();
    const done = await getBatch(m.db, batch.id);
    expect(done).toMatchObject({ status: 'done', done: 3, failed: 3 });
    expect(done.results[3]).toMatchObject({ row: 4, error: 'images.daily_cap' });
    expect(done.results[3]!.url).toBeUndefined();

    const lines = batchCsv(done).trim().split(/\r?\n/);
    expect(lines[0]).toBe('row,url,error,message');
    expect(lines).toHaveLength(7);
    expect(lines[1]).toMatch(/^1,http:\/\/localhost\/i\//);
    expect(lines[4]).toMatch(/^4,,images\.daily_cap,/);
  });

  it('is marked failed when no row could be drawn', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: titles(2), format: 'png' }, BASE);
    // Server PNG is off, so every row is refused. PNG rows run one at a time.
    expect(await m.t.drainJobs()).toBe(2);
    expect(await getBatch(m.db, batch.id)).toMatchObject({ status: 'failed', done: 0, failed: 2 });
  });

  it('does nothing when the same message is delivered again', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: titles(3) }, BASE);
    const payload = { orgId: m.t.org.id, batchId: batch.id };
    await m.t.drainJobs();
    const before = await getBatch(m.db, batch.id);
    await runBatch(m.t.env, payload);
    await runBatch(m.t.env, { orgId: 'org_other', batchId: batch.id });
    expect(await getBatch(m.db, batch.id)).toEqual(before);
    const events = await recentEvents(m.t.env, m.t.org.id, { module: 'images', limit: 50 });
    expect(events.filter((e) => e.name === 'batch.completed')).toHaveLength(1);
  });

  it('packs the finished images and the results into one ZIP', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: [{ title: 'Same' }, { title: 'Same' }, { title: 'Other' }] }, BASE);
    await m.t.drainJobs();
    const zip = await zipOf(m, batch.id);
    expect([...zip.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('001.svg');
    // Rows 1 and 2 are the same picture, so it is in the archive once.
    expect(text).not.toContain('002.svg');
    expect(text).toContain('003.svg');
    expect(text).toContain('results.csv');
  });

  it('can be removed once finished, and is only ever seen by its own workspace', async () => {
    const m = await mounted();
    const template = await blogTemplate(m);
    const batch = await createBatch(m.t.env, m.db, { templateId: template.id, rows: titles(1) }, BASE);
    await expect(deleteBatch(m.db, batch.id)).rejects.toMatchObject({ code: 'images.batch_running' });
    const other = orgDb(m.t.env.DB, 'org_other');
    await expect(getBatch(other, batch.id)).rejects.toMatchObject({ code: 'not_found' });
    expect((await listBatches(other)).items).toEqual([]);
    await expect(createBatch(m.t.env, other, { templateId: template.id, rows: titles(1) }, BASE)).rejects.toMatchObject({ code: 'not_found' });

    await m.t.drainJobs();
    expect((await listBatches(m.db)).items.map((b) => b.id)).toEqual([batch.id]);
    await deleteBatch(m.db, batch.id);
    expect((await listBatches(m.db)).items).toEqual([]);
  });
});
