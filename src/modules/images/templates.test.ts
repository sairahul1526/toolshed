import { describe, expect, it } from 'vitest';
import { orgDb } from '../../core/db';
import { AppError } from '../../core/errors';
import { recentEvents } from '../../core/events';
import { blankDoc } from './schema';
import {
  createTemplate,
  deleteTemplate,
  duplicateTemplate,
  exportTemplate,
  getTemplate,
  importTemplate,
  listTemplates,
  MAX_TEMPLATES,
  publishTemplate,
  revertTemplate,
  updateTemplate,
} from './templates';
import { mounted } from './test-support';

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    if (err instanceof AppError) return err.code;
    throw err;
  }
  return 'no error';
}

describe('templates', () => {
  it('makes a draft from a starter with a URL name of its own', async () => {
    const m = await mounted();
    const template = await createTemplate(m.t.env, m.db, { starter: 'blog' }, { id: 'usr_1' }, 1_700_000_000_000);
    expect(template.name).toBe('Blog post');
    expect(template.slug).toMatch(/^blog-post-[a-z0-9]{4}$/);
    expect(template).toMatchObject({ width: 1200, height: 630, version: 0, published: false, open: false, page: false, renders: 0 });
    expect(template.doc.fields.map((f) => f.name)).toEqual(['title', 'site', 'author', 'accent']);
    const [event] = await recentEvents(m.t.env, m.t.org.id, { module: 'images' });
    expect(event).toMatchObject({ name: 'template.created', subject: template.id, data: { id: template.id, slug: template.slug, name: 'Blog post', width: 1200, height: 630 } });
  });

  it('makes a blank canvas from a size preset or a width and height', async () => {
    const m = await mounted();
    const story = await createTemplate(m.t.env, m.db, { preset: 'instagram-story', name: 'Story' });
    expect([story.width, story.height]).toEqual([1080, 1920]);
    const custom = await createTemplate(m.t.env, m.db, { width: 800, height: 400 });
    expect([custom.width, custom.height, custom.name]).toEqual([800, 400, 'Untitled image']);
    expect(await codeOf(createTemplate(m.t.env, m.db, { preset: 'poster' }))).toBe('validation_failed');
    expect(await codeOf(createTemplate(m.t.env, m.db, { starter: 'nope' }))).toBe('validation_failed');
    expect(await codeOf(createTemplate(m.t.env, m.db, { width: 5000, height: 400 }))).toBe('validation_failed');
  });

  it('gives two templates with the same name different URL names', async () => {
    const m = await mounted();
    const a = await createTemplate(m.t.env, m.db, { starter: 'blog' });
    const b = await createTemplate(m.t.env, m.db, { starter: 'blog' });
    expect(a.slug).not.toBe(b.slug);
  });

  it('keeps image URLs on the published look until the draft is published', async () => {
    const m = await mounted();
    const created = await createTemplate(m.t.env, m.db, { starter: 'blog', publish: true });
    expect(created).toMatchObject({ version: 1, published: true, unpublishedChanges: false });

    const doc = { ...created.doc, background: '#ffffff' };
    const edited = await updateTemplate(m.db, created.id, { doc });
    expect(edited).toMatchObject({ version: 1, unpublishedChanges: true });
    expect(edited.publishedDoc?.background).toBe('#0f172a');

    const published = await publishTemplate(m.t.env, m.db, created.id);
    expect(published).toMatchObject({ version: 2, unpublishedChanges: false });
    expect(published.publishedDoc?.background).toBe('#ffffff');
    // Publishing again with nothing new does not make a new version.
    expect((await publishTemplate(m.t.env, m.db, created.id)).version).toBe(2);
    const events = await recentEvents(m.t.env, m.t.org.id, { module: 'images' });
    expect(events.filter((e) => e.name === 'template.updated')).toHaveLength(1);
  });

  it('goes back to the published look on revert', async () => {
    const m = await mounted();
    const created = await createTemplate(m.t.env, m.db, { starter: 'blog', publish: true });
    await updateTemplate(m.db, created.id, { doc: { ...created.doc, background: '#ffffff' } });
    const reverted = await revertTemplate(m.db, created.id);
    expect(reverted.doc.background).toBe('#0f172a');
    expect(reverted.unpublishedChanges).toBe(false);
  });

  it('refuses a design that does not hold together, with the field that is wrong', async () => {
    const m = await mounted();
    const created = await createTemplate(m.t.env, m.db, { starter: 'blog' });
    const broken = { ...created.doc, fields: [] };
    try {
      await updateTemplate(m.db, created.id, { doc: broken });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('validation_failed');
      expect(Object.keys((err as AppError).fields ?? {})).toContain('layers.0.fill');
    }
    const tooWide = { ...created.doc, width: 9000 };
    expect(await codeOf(updateTemplate(m.db, created.id, { doc: tooWide }))).toBe('validation_failed');
  });

  it('changes the URL name, and refuses one another workspace already uses', async () => {
    const m = await mounted();
    const mine = await createTemplate(m.t.env, m.db, { starter: 'blog' });
    const theirs = await createTemplate(m.t.env, orgDb(m.t.env.DB, 'org_other'), { starter: 'blog' });
    expect((await updateTemplate(m.db, mine.id, { slug: 'My-Card' })).slug).toBe('my-card');
    expect(await codeOf(updateTemplate(m.db, mine.id, { slug: theirs.slug }))).toBe('images.slug_taken');
    expect(await codeOf(updateTemplate(m.db, mine.id, { slug: 'a' }))).toBe('validation_failed');
    expect(await codeOf(updateTemplate(m.db, mine.id, { slug: 'has space' }))).toBe('validation_failed');
  });

  it('copies a template as a new draft', async () => {
    const m = await mounted();
    const source = await createTemplate(m.t.env, m.db, { starter: 'quote', publish: true });
    const copy = await duplicateTemplate(m.t.env, m.db, source.id);
    expect(copy.name).toBe(`${source.name} copy`);
    expect(copy.doc).toEqual(source.doc);
    expect(copy).toMatchObject({ published: false, version: 0 });
    expect(copy.slug).not.toBe(source.slug);
  });

  it('exports a template and imports it again', async () => {
    const m = await mounted();
    const source = await createTemplate(m.t.env, m.db, { starter: 'launch' });
    const file = exportTemplate(source);
    expect(file).toMatchObject({ kind: 'toolshed.images.template', v: 1, name: 'Launch card' });
    const fromObject = await importTemplate(m.t.env, m.db, file);
    const fromText = await importTemplate(m.t.env, m.db, JSON.stringify(file));
    expect(fromObject.doc).toEqual(source.doc);
    expect(fromText.doc).toEqual(source.doc);
    expect(await codeOf(importTemplate(m.t.env, m.db, '{not json'))).toBe('images.bad_template');
    expect(await codeOf(importTemplate(m.t.env, m.db, { kind: 'something.else', v: 1, name: 'x', doc: {} }))).toBe('images.bad_template');
    expect(await codeOf(importTemplate(m.t.env, m.db, { ...file, doc: { ...file.doc, layers: 'none' } }))).toBe('validation_failed');
  });

  it('deletes a template now and its stored images in the background', async () => {
    const m = await mounted();
    const template = await createTemplate(m.t.env, m.db, { starter: 'blog', publish: true });
    await deleteTemplate(m.t.env, m.db, template.id);
    expect(await codeOf(getTemplate(m.db, template.id))).toBe('not_found');
    expect(m.t.queue.sent.map((job) => job.body)).toEqual([{ name: 'images.purge', payload: { orgId: m.t.org.id, templateId: template.id, keepBaked: false } }]);
  });

  it('lists a page at a time, newest first', async () => {
    const m = await mounted();
    for (let i = 0; i < 5; i++) await createTemplate(m.t.env, m.db, { name: `Card ${i}`, doc: blankDoc(400, 200) }, {}, 1_700_000_000_000 + i * 1000);
    const first = await listTemplates(m.db, { limit: 2 });
    expect(first.items.map((t) => t.name)).toEqual(['Card 4', 'Card 3']);
    const second = await listTemplates(m.db, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((t) => t.name)).toEqual(['Card 2', 'Card 1']);
    const last = await listTemplates(m.db, { limit: 2, cursor: second.nextCursor });
    expect(last.items.map((t) => t.name)).toEqual(['Card 0']);
    expect(last.nextCursor).toBeNull();
    expect('doc' in first.items[0]!).toBe(false);
  });

  it('stops at the workspace’s limit of templates', async () => {
    const m = await mounted();
    const doc = JSON.stringify(blankDoc(400, 200));
    const insert = m.t.sqlite.prepare(`INSERT INTO img_templates (id, org_id, slug, name, doc, created_at, updated_at) VALUES (?, 'org_test', ?, 'Card', ?, 1, 1)`);
    for (let i = 0; i < MAX_TEMPLATES; i++) insert.run(`imgt_fill${i}`, `fill-${i}`, doc);
    expect(await codeOf(createTemplate(m.t.env, m.db, { starter: 'blog' }))).toBe('images.too_many_templates');
  });

  it('never shows one workspace another workspace’s template', async () => {
    const m = await mounted();
    const theirs = await createTemplate(m.t.env, orgDb(m.t.env.DB, 'org_other'), { starter: 'blog' });
    expect(await codeOf(getTemplate(m.db, theirs.id))).toBe('not_found');
    expect(await codeOf(updateTemplate(m.db, theirs.id, { name: 'Mine now' }))).toBe('not_found');
    expect(await codeOf(deleteTemplate(m.t.env, m.db, theirs.id))).toBe('not_found');
    expect((await listTemplates(m.db)).items).toEqual([]);
  });
});
