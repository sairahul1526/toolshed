/** Example data so a new workspace has something to look at. Everything it adds is marked and can be removed in one go. */
import { newId } from '../../core/db';
import type { Ctx } from './types';

const PEOPLE: [string, string][] = [
  ['Avery Chen', 'avery@example.com'],
  ['Jordan Blake', 'jordan@example.com'],
  ['Sam Ortiz', 'sam@example.com'],
  ['Riley Patel', 'riley@example.com'],
  ['Morgan Lee', 'morgan@example.com'],
  ['Casey Novak', 'casey@example.com'],
];

export async function addSampleData(ctx: Ctx, now = Date.now()): Promise<void> {
  if ((await ctx.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM mail_lists WHERE org_id = :org AND is_sample = 1'))!.n > 0) return;
  const listId = newId('mls', now);
  const slug = `sample-${listId.slice(-6).toLowerCase()}`;
  const stmts = [
    ctx.db.d1
      .prepare(`INSERT INTO mail_lists (id, org_id, name, slug, description, is_sample, created_at, updated_at) VALUES (?1, ?2, 'Sample newsletter', ?3, 'An example newsletter. Safe to delete.', 1, ?4, ?4)`)
      .bind(listId, ctx.org.id, slug, now),
  ];
  const ids: string[] = [];
  PEOPLE.forEach(([name, email], i) => {
    const id = newId('msb', now + i);
    ids.push(id);
    const joined = now - (i + 1) * 86_400_000;
    stmts.push(
      ctx.db.d1
        .prepare(`INSERT INTO mail_subscribers (id, org_id, email, name, source, consent_note, consent_at, is_sample, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'sample', 'Sample data', ?5, 1, ?5, ?5)`)
        .bind(id, ctx.org.id, `sample-${email}`, name, joined),
      ctx.db.d1
        .prepare(`INSERT INTO mail_memberships (org_id, list_id, subscriber_id, status, joined_at, confirmed_at) VALUES (?1, ?2, ?3, 'active', ?4, ?4)`)
        .bind(ctx.org.id, listId, id, joined),
    );
  });
  const bid = newId('mlb', now);
  stmts.push(
    ctx.db.d1
      .prepare(
        `INSERT INTO mail_broadcasts (id, org_id, list_id, subject, preheader, format, body, status, started_at, finished_at, total, sent_count, source, is_sample, created_at, updated_at)
         VALUES (?1, ?2, ?3, 'Welcome to the sample newsletter', 'A short example issue', 'markdown', ?4, 'sent', ?5, ?5, ?6, ?6, 'sample', 1, ?5, ?5)`,
      )
      .bind(bid, ctx.org.id, listId, 'Hi {{first_name|there}},\n\nThis is a sample issue. Delete it whenever you like.\n\n::button[Read more](https://example.com)', now - 3_600_000, PEOPLE.length),
  );
  await ctx.db.d1.batch(stmts);
}

export async function removeSampleData(ctx: Ctx): Promise<void> {
  const org = ctx.org.id;
  const d1 = ctx.db.d1;
  await d1.batch([
    d1.prepare('DELETE FROM mail_memberships WHERE org_id = ?1 AND (list_id IN (SELECT id FROM mail_lists WHERE org_id = ?1 AND is_sample = 1) OR subscriber_id IN (SELECT id FROM mail_subscribers WHERE org_id = ?1 AND is_sample = 1))').bind(org),
    d1.prepare('DELETE FROM mail_subscriber_tags WHERE org_id = ?1 AND subscriber_id IN (SELECT id FROM mail_subscribers WHERE org_id = ?1 AND is_sample = 1)').bind(org),
    d1.prepare('DELETE FROM mail_deliveries WHERE org_id = ?1 AND broadcast_id IN (SELECT id FROM mail_broadcasts WHERE org_id = ?1 AND is_sample = 1)').bind(org),
    d1.prepare('DELETE FROM mail_links WHERE org_id = ?1 AND broadcast_id IN (SELECT id FROM mail_broadcasts WHERE org_id = ?1 AND is_sample = 1)').bind(org),
    d1.prepare('DELETE FROM mail_broadcasts WHERE org_id = ?1 AND is_sample = 1').bind(org),
    d1.prepare('DELETE FROM mail_subscribers WHERE org_id = ?1 AND is_sample = 1').bind(org),
    d1.prepare('DELETE FROM mail_lists WHERE org_id = ?1 AND is_sample = 1').bind(org),
  ]);
}
