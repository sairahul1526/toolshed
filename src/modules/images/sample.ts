/** Sample data: one published starter and a week of usage, so every screen has something to show. */
import type { ModuleContext } from '../../core/module';
import { enqueue } from '../../core/jobs';
import { createTemplate } from './templates';
import { dayOf } from './usage';

const DAY_MS = 24 * 60 * 60 * 1000;
/** New images and cache hits for the last seven days, oldest first. */
const WEEK: [renders: number, hits: number][] = [
  [4, 61],
  [7, 148],
  [3, 97],
  [9, 212],
  [6, 180],
  [2, 75],
  [5, 133],
];

export async function addSample(ctx: ModuleContext, now = Date.now()): Promise<void> {
  if (await ctx.db.findOne('img_templates', { sample: 1 })) return;
  const template = await createTemplate(ctx.env, ctx.db, { starter: 'blog', name: 'Blog post card (sample)', publish: true }, {}, now, { sample: true });
  await ctx.env.DB.batch(
    WEEK.map(([renders, hits], i) =>
      ctx.env.DB.prepare(
        `INSERT INTO img_daily (org_id, day, template_id, renders, hits, errors, bytes) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
         ON CONFLICT (org_id, day, template_id) DO NOTHING`,
      ).bind(ctx.org.id, dayOf(now - (WEEK.length - i) * DAY_MS), template.id, renders, hits, renders * 9200),
    ),
  );
}

/** Removes the sample templates with everything counted or stored for them. */
export async function clearSample(ctx: ModuleContext): Promise<void> {
  const rows = await ctx.db.all<{ id: string }>('SELECT id FROM img_templates WHERE org_id = :org AND sample = 1');
  for (const { id } of rows) {
    await ctx.db.run('DELETE FROM img_daily WHERE org_id = :org AND template_id = ?', id);
    await ctx.db.run('DELETE FROM img_log WHERE org_id = :org AND template_id = ?', id);
    await ctx.db.remove('img_templates', id);
    await enqueue(ctx.env, 'images.purge', { orgId: ctx.org.id, templateId: id, keepBaked: false });
  }
}
