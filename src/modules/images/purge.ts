/**
 * Removing stored images in the background, a few hundred at a time, after a template is deleted
 * or its cache is emptied. Each run deletes the files first and their rows second, so a run that
 * stops halfway leaves rows that the next run picks up again.
 */
import { z } from 'zod';
import { orgDb } from '../../core/db';
import { parse } from '../../core/errors';
import { enqueue } from '../../core/jobs';
import type { Env } from '../../env';
import { renderKey } from './keys';

const PER_RUN = 200;

const payloadSchema = z.object({ orgId: z.string().min(1), templateId: z.string().min(1), keepBaked: z.boolean().default(false) });

export async function runPurge(env: Env, payload: unknown): Promise<void> {
  const { orgId, templateId, keepBaked } = parse(payloadSchema, payload);
  const db = orgDb(env.DB, orgId);
  const rows = await db.all<{ id: string; hash: string; format: string }>(
    `SELECT id, hash, format FROM img_renders WHERE org_id = :org AND template_id = ?${keepBaked ? ` AND source != 'bake'` : ''} ORDER BY id LIMIT ?`,
    templateId,
    PER_RUN,
  );
  if (rows.length > 0) {
    await env.FILES.delete(rows.map((row) => renderKey(orgId, row.hash, row.format)));
    // 50 ids per statement keeps each one well under the database's limit on bound values.
    for (let at = 0; at < rows.length; at += 50) {
      const ids = rows.slice(at, at + 50).map((row) => row.id);
      await db.run(`DELETE FROM img_renders WHERE org_id = :org AND id IN (${ids.map(() => '?').join(', ')})`, ...ids);
    }
  }
  if (rows.length === PER_RUN) {
    await enqueue(env, 'images.purge', { orgId, templateId, keepBaked });
    return;
  }
  // Counts that have not been rolled up yet would otherwise point at images that no longer exist.
  await db.run('DELETE FROM img_hits WHERE org_id = :org AND template_id = ?', templateId);
  if (!keepBaked) await db.run('DELETE FROM img_batches WHERE org_id = :org AND template_id = ?', templateId);
}
