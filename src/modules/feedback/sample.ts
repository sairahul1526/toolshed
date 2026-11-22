/** Believable sample data. Every row is marked sample = 1 so "Clear sample data" removes exactly these. */
import { newId } from '../../core/db';
import type { ModuleContext } from '../../core/module';
import { createPortal, getPortal, listBoards, listStatuses, type Ctx } from './portal';
import type { Board, Status } from './types';
import { randomSuffix, slugify } from './util';

const DAY = 86400000;

const PEOPLE = [
  ['Maya Okafor', 'maya@example.com'],
  ['Jonas Weber', 'jonas@example.com'],
  ['Priya Nair', 'priya@example.com'],
  ['Diego Alvarez', 'diego@example.com'],
  ['Hannah Lee', 'hannah@example.com'],
  ['Tom Becker', 'tom@example.com'],
  ['Aiko Tanaka', 'aiko@example.com'],
  ['Sam Rivera', 'sam@example.com'],
];

const POSTS: { title: string; body: string; status: string; votes: number; age: number; replies?: string }[] = [
  { title: 'Dark mode for the dashboard', body: 'Working late, the bright dashboard is hard on the eyes. A dark theme that follows the system setting would be great.', status: 'In progress', votes: 8, age: 21, replies: 'Started this week. We will ship it with the next release.' },
  { title: 'Export reports to CSV', body: 'I need to hand numbers to finance every month. A CSV export on every report would save me an hour.', status: 'Planned', votes: 7, age: 18 },
  { title: 'Slack notifications for new comments', body: 'Let us pick a Slack channel and post there when someone comments on a request.', status: 'Under review', votes: 6, age: 14 },
  { title: 'Single sign-on with Google', body: 'Our team lives in Google Workspace. Signing in with it would remove one more password.', status: 'Open', votes: 5, age: 11 },
  { title: 'Keyboard shortcuts', body: 'Add shortcuts for the common actions: new item, search, jump to inbox.', status: 'Complete', votes: 5, age: 40, replies: 'Shipped. Press the question mark key to see the list.' },
  { title: 'Mobile app', body: 'A phone app, or at least a layout that works well on a small screen, for checking things on the go.', status: 'Open', votes: 4, age: 9 },
  { title: 'Bulk edit statuses', body: 'Selecting ten requests and changing their status one by one takes a long time.', status: 'Open', votes: 3, age: 6 },
  { title: 'Weekly summary email', body: 'A short email each Monday with what changed would keep my team in the loop.', status: 'Planned', votes: 3, age: 5 },
  { title: 'Custom fields on requests', body: 'We want to record the customer plan and region on every request.', status: 'Open', votes: 2, age: 3 },
  { title: 'Let people attach screenshots', body: 'Screenshots explain bugs far better than words. Allow attachments on new requests.', status: 'Closed', votes: 2, age: 25, replies: 'We are not adding uploads from visitors right now because of the moderation work they bring.' },
  { title: 'API access for reading requests', body: 'I would like to pull requests into our own tools with a simple API key.', status: 'Open', votes: 1, age: 2 },
  { title: 'Show the roadmap in our help center', body: 'We want to embed the roadmap page into our docs.', status: 'Open', votes: 1, age: 1 },
];

export async function seedSample(mctx: ModuleContext): Promise<void> {
  const ctx: Ctx = { env: mctx.env, orgId: mctx.org.id, db: mctx.db };
  if (!(await getPortal(ctx))) await createPortal(ctx, { name: mctx.org.name || 'Product feedback', tagline: 'Tell us what to build next.' });
  const now = Date.now();
  const boards: Board[] = await listBoards(ctx);
  const board = boards[0]!;
  const statuses: Status[] = await listStatuses(ctx);
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const stmts: D1PreparedStatement[] = [];
  const DB = ctx.env.DB;
  const peopleIds: string[] = [];
  PEOPLE.forEach(([name, email], i) => {
    const id = newId('fbu', now + i);
    peopleIds.push(id);
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO fb_people (id, org_id, email, name, source, verified, trusted, blocked, mail_off, sample, created_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 'sample', 1, 0, 0, 1, 1, ?5, ?5)`).bind(id, ctx.orgId, `sample-${email}`, name, now - 30 * DAY));
  });
  POSTS.forEach((p, i) => {
    const id = newId('fbq', now + i);
    const created = now - p.age * DAY;
    const status = byName.get(p.status);
    const author = peopleIds[i % peopleIds.length]!;
    stmts.push(
      DB.prepare(
        `INSERT INTO fb_posts (id, org_id, board_id, slug, title, body, author_id, status_id, review, source, vote_count, comment_count, trend, voted_milestone, first_reply_at, status_changed_at, sample, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'published', 'sample', 0, 0, 0, 0, ?9, ?10, 1, ?10, ?10)`,
      ).bind(id, ctx.orgId, board.id, `${slugify(p.title, 50)}-${randomSuffix(4)}`, p.title, p.body, author, status?.id ?? null, p.replies ? created + 3 * 3600000 : null, created),
    );
    // Votes from distinct sample people. The trigger keeps vote_count in step.
    for (let v = 0; v < Math.min(p.votes, peopleIds.length); v++) {
      stmts.push(DB.prepare(`INSERT OR IGNORE INTO fb_votes (org_id, post_id, person_id, source, created_at) VALUES (?1, ?2, ?3, 'sample', ?4)`).bind(ctx.orgId, id, peopleIds[(i + v) % peopleIds.length]!, created + v * 3600000));
    }
    if (p.replies) {
      stmts.push(DB.prepare(`INSERT INTO fb_comments (id, org_id, post_id, author_id, staff_user, staff_name, body, review, sample, created_at) VALUES (?1, ?2, ?3, NULL, NULL, 'The team', ?4, 'published', 1, ?5)`).bind(newId('fbm', now + i), ctx.orgId, id, p.replies, created + 3 * 3600000));
    }
    if (i % 3 === 0) {
      stmts.push(DB.prepare(`INSERT INTO fb_comments (id, org_id, post_id, author_id, staff_user, staff_name, body, review, sample, created_at) VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5, 'published', 1, ?6)`).bind(newId('fbm', now + 100 + i), ctx.orgId, id, peopleIds[(i + 2) % peopleIds.length]!, 'This would help our team a lot too.', created + DAY));
    }
  });
  const entries: [string, string, string[], number][] = [
    ['Keyboard shortcuts are here', 'Move faster without the mouse. Press **?** anywhere to see every shortcut.\n\n- New item: `n`\n- Search: `/`\n- Jump to inbox: `g` then `i`', ['New'], 12],
    ['Faster search', 'Search now returns results as you type and handles typos. Large workspaces see the biggest gain.', ['Improved'], 26],
    ['Fixed duplicate notifications', 'People who followed a request and also commented no longer get two emails for the same reply.', ['Fixed'], 40],
  ];
  entries.forEach(([title, body, labels, age], i) => {
    const at = now - age * DAY;
    stmts.push(
      DB.prepare(`INSERT INTO fb_entries (id, org_id, slug, title, body, labels, state, published_at, complete_posts, author_name, sample, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'published', ?7, 0, 'The team', 1, ?7, ?7)`).bind(newId('fbe', now + i), ctx.orgId, `${slugify(title, 40)}-${randomSuffix(3)}`, title, body, JSON.stringify(labels), at),
    );
  });
  ['ada@example.com', 'ben@example.com', 'cleo@example.com'].forEach((email, i) => {
    stmts.push(DB.prepare(`INSERT OR IGNORE INTO fb_subscribers (id, org_id, email, status, frequency, sample, created_at, confirmed_at) VALUES (?1, ?2, ?3, 'active', ?4, 1, ?5, ?5)`).bind(newId('fbs2', now + i), ctx.orgId, `sample-${email}`, ['each', 'weekly', 'monthly'][i], now - 10 * DAY));
  });
  for (let i = 0; i < stmts.length; i += 80) await DB.batch(stmts.slice(i, i + 80));
}

export async function clearSample(mctx: ModuleContext): Promise<void> {
  const org = mctx.org.id;
  const DB = mctx.env.DB;
  const q = (sql: string) => DB.prepare(sql).bind(org);
  await DB.batch([
    q('DELETE FROM fb_votes WHERE org_id = ?1 AND post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1)'),
    q('DELETE FROM fb_post_tags WHERE org_id = ?1 AND post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1)'),
    q('DELETE FROM fb_notes WHERE org_id = ?1 AND post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1)'),
    q('DELETE FROM fb_status_log WHERE org_id = ?1 AND post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1)'),
    q('DELETE FROM fb_entry_posts WHERE org_id = ?1 AND (post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1) OR entry_id IN (SELECT id FROM fb_entries WHERE org_id = ?1 AND sample = 1))'),
    q('DELETE FROM fb_comments WHERE org_id = ?1 AND (sample = 1 OR post_id IN (SELECT id FROM fb_posts WHERE org_id = ?1 AND sample = 1))'),
    q('DELETE FROM fb_posts WHERE org_id = ?1 AND sample = 1'),
    q('DELETE FROM fb_entries WHERE org_id = ?1 AND sample = 1'),
    q('DELETE FROM fb_subscribers WHERE org_id = ?1 AND sample = 1'),
    q('DELETE FROM fb_people WHERE org_id = ?1 AND sample = 1'),
  ]);
}
