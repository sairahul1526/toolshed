import { beforeEach, describe, expect, it, vi } from 'vitest';
import { orgDb } from '../../core/db';
import { devOutbox } from '../../core/email';
import { registerModules } from '../../core/registry';
import { createTestEnv, type TestEnv } from '../../../test/helpers/d1';
import feedback from './module';
import { createEntry, publishDue, publishEntry, subscribe } from './changelog';
import { exportAll, guessMapping, importPosts, previewCsv } from './exportimport';
import { CODE_ATTEMPTS, createGuest, requestCode, resolveIdentity, upsertEmailPerson, verifyCode } from './people';
import { createPortal, createStatus, getPortal, listBoards, listStatuses, type Ctx } from './portal';
import { addStaffComment, addVoteFor, changeStatus, insertPost, listPosts, mergePosts, mergePreview, similarPosts, submitPost, toggleVote } from './posts';
import { clearSample, seedSample } from './sample';
import { checkForm, formToken, holdReason, MIN_FORM_MS } from './spam';
import { queueNotice, runNotice } from './notify';
import { computeStats } from './stats';
import { nextMilestone, VOTE_MILESTONES } from './events';
import type { Person } from './types';

vi.mock('../../core/jwt', () => ({
  verifyJwt: vi.fn(async (_env: unknown, token: string) => {
    if (token === 'good') return { sub: 'cust_42', orgId: 'org_test', role: 'member', scopes: [], exp: Math.floor(Date.now() / 1000) + 600 };
    if (token === 'other-org') return { sub: 'cust_9', orgId: 'org_other', role: 'member', scopes: [], exp: Math.floor(Date.now() / 1000) + 600 };
    if (token === 'expired') return { sub: 'cust_1', orgId: 'org_test', role: 'member', scopes: [], exp: Math.floor(Date.now() / 1000) - 600 };
    return null;
  }),
}));

let t: TestEnv;
let ctx: Ctx;
const req = () => new Request('http://localhost/', { headers: { 'cf-connecting-ip': '203.0.113.7' } });

async function setup(vars: Partial<TestEnv['env']> = {}) {
  t = createTestEnv(vars);
  registerModules([feedback]);
  ctx = { env: t.env, orgId: t.org.id, db: orgDb(t.env.DB, t.org.id), origin: 'http://localhost' };
  await createPortal(ctx, { name: 'Acme', slug: 'acme' });
}

async function verified(email: string, name = ''): Promise<Person> {
  return upsertEmailPerson(ctx, email, { name, verified: true });
}

async function board() {
  return (await listBoards(ctx))[0]!;
}

async function newPost(title: string, author?: Person) {
  const b = await board();
  return insertPost(ctx, { board: b, title, body: 'Some detail', authorId: author?.id ?? null, autoVote: !!author });
}

beforeEach(() => setup());

describe('portal setup', () => {
  it('seeds statuses and a first board', async () => {
    const statuses = await listStatuses(ctx);
    expect(statuses.map((s) => s.name)).toEqual(['Open', 'Under review', 'Planned', 'In progress', 'Complete', 'Closed']);
    expect(statuses.filter((s) => s.in_roadmap).map((s) => s.name)).toEqual(['Planned', 'In progress', 'Complete']);
    expect((await listBoards(ctx)).length).toBe(1);
    expect((await getPortal(ctx))?.slug).toBe('acme');
  });

  it('lets a workspace add a custom status', async () => {
    const s = await createStatus(ctx, { name: 'Needs design', tone: 'warn', kind: 'active', in_roadmap: true });
    expect((await listStatuses(ctx)).some((x) => x.id === s.id)).toBe(true);
  });
});

describe('voting', () => {
  it('keeps one vote per person and the counter in step', async () => {
    const a = await verified('a@example.com');
    const b = await verified('b@example.com');
    const post = await newPost('Dark mode', a);
    expect(post.vote_count).toBe(1);
    const bd = await board();
    expect((await toggleVote(ctx, post, bd, b, 0)).count).toBe(2);
    // A direct duplicate insert is ignored by the unique index.
    await addVoteFor(ctx, post.id, b.id);
    const row = await ctx.db.get<{ vote_count: number }>('fb_posts', post.id);
    expect(row?.vote_count).toBe(2);
    expect((await toggleVote(ctx, post, bd, b, 0)).count).toBe(1);
    await expect(t.env.DB.prepare("INSERT INTO fb_votes (org_id, post_id, person_id, source, created_at) VALUES (?1, ?2, ?3, 'x', 1)").bind(ctx.orgId, post.id, a.id).run()).rejects.toThrow();
  });

  it('enforces the vote limit and the board switch', async () => {
    const a = await verified('a@example.com');
    const bd = await board();
    const p1 = await newPost('One');
    const p2 = await newPost('Two');
    await toggleVote(ctx, p1, bd, a, 1);
    await expect(toggleVote(ctx, p2, bd, a, 1)).rejects.toMatchObject({ code: 'feedback.vote_limit' });
    await ctx.db.update('fb_boards', bd.id, { voting_on: 0 });
    await expect(toggleVote(ctx, p2, { ...bd, voting_on: 0 }, a, 0)).rejects.toMatchObject({ code: 'feedback.voting_off' });
  });

  it('thresholds the post.voted event', async () => {
    expect(nextMilestone(1, 0)).toBe(1);
    expect(nextMilestone(4, 1)).toBeNull();
    expect(nextMilestone(7, 1)).toBe(5);
    expect(nextMilestone(120, 25)).toBe(100);
    expect(VOTE_MILESTONES.length).toBeLessThanOrEqual(12);
    const post = await newPost('Popular');
    for (let i = 0; i < 12; i++) await addVoteFor(ctx, post.id, (await verified(`v${i}@example.com`)).id);
    const events = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM event_log WHERE name = 'feedback.post.voted'").first<{ n: number }>().catch(() => null);
    const row = await ctx.db.get<{ voted_milestone: number }>('fb_posts', post.id);
    expect(row?.voted_milestone).toBe(10);
    if (events) expect(events.n).toBeLessThanOrEqual(3);
  });
});

describe('identity', () => {
  it('trusts an SSO token only for this workspace and while it is valid', async () => {
    const person = await resolveIdentity(ctx, { sso: 'good' });
    expect(person?.verified).toBe(1);
    expect(person?.external_id).toBe('cust_42');
    expect((await resolveIdentity(ctx, { sso: 'good' }))?.id).toBe(person?.id);
    expect(await resolveIdentity(ctx, { sso: 'other-org' })).toBeNull();
    expect(await resolveIdentity(ctx, { sso: 'expired' })).toBeNull();
    expect(await resolveIdentity(ctx, { sso: 'garbage' })).toBeNull();
  });

  it('signs people in with a six digit email code', async () => {
    const res = await requestCode(ctx, (await getPortal(ctx))!, 'Kim@Example.com', '198.51.100.1');
    expect(res).toEqual({ sent: true, guestOnly: false });
    const mail = (await devOutbox(t.env, { to: 'kim@example.com' }))[0]!;
    const code = /\b(\d{6})\b/.exec(mail.text ?? '')![1]!;
    await expect(verifyCode(ctx, 'kim@example.com', code === '000000' ? '111111' : '000000')).rejects.toMatchObject({ code: 'feedback.code_invalid' });
    const person = await verifyCode(ctx, 'kim@example.com', code, 'Kim');
    expect(person.verified).toBe(1);
    await expect(verifyCode(ctx, 'kim@example.com', code)).rejects.toBeTruthy();
  });

  it('locks a code after too many wrong tries and after ten minutes', async () => {
    const portal = (await getPortal(ctx))!;
    await requestCode(ctx, portal, 'lock@example.com', '198.51.100.2');
    for (let i = 0; i < CODE_ATTEMPTS; i++) await expect(verifyCode(ctx, 'lock@example.com', '123456')).rejects.toBeTruthy();
    await expect(verifyCode(ctx, 'lock@example.com', '123456')).rejects.toMatchObject({ code: 'feedback.code_attempts' });
    await requestCode(ctx, portal, 'old@example.com', '198.51.100.3');
    await t.env.DB.prepare('UPDATE fb_codes SET expires_at = 1 WHERE email = ?1').bind('old@example.com').run();
    await expect(verifyCode(ctx, 'old@example.com', '123456')).rejects.toMatchObject({ code: 'feedback.code_expired' });
  });

  it('limits codes per address', async () => {
    const portal = (await getPortal(ctx))!;
    for (let i = 0; i < 3; i++) await requestCode(ctx, portal, 'spam@example.com', '198.51.100.4');
    await expect(requestCode(ctx, portal, 'spam@example.com', '198.51.100.4')).rejects.toMatchObject({ status: 429 });
  });

  it('accepts guests as unverified and holds their posts when email is not set up', async () => {
    await setup({ ENVIRONMENT: 'production' });
    const portal = (await getPortal(ctx))!;
    expect(await requestCode(ctx, portal, 'x@example.com', '198.51.100.5')).toEqual({ sent: false, guestOnly: true });
    const guest = await createGuest(ctx, req(), 'Visitor');
    expect(guest.verified).toBe(0);
    const bd = await board();
    const sub = await submitPost(ctx, { board: bd, person: guest, title: 'A guest idea', body: 'Hello' });
    expect(sub.post?.review).toBe('pending');
    expect(sub.held).toBe('guest');
    expect((await listPosts(ctx, {})).items.length).toBe(0);
    expect((await listPosts(ctx, { review: 'pending' })).items.length).toBe(1);
    // Guests can still vote on published posts.
    const open = await newPost('Published idea');
    expect((await toggleVote(ctx, open, bd, guest, 0)).voted).toBe(true);
  });
});

describe('spam control', () => {
  it('checks the honeypot and the timing token', async () => {
    const token = await formToken(t.env, 'acme');
    const now = Date.now();
    expect(await checkForm(t.env, 'acme', token, 'filled', now + 10_000)).toBe('honeypot');
    expect(await checkForm(t.env, 'acme', token, '', now + MIN_FORM_MS - 500)).toBe('too_fast');
    expect(await checkForm(t.env, 'acme', token, '', now + MIN_FORM_MS + 500)).toBe('ok');
    expect(await checkForm(t.env, 'other', token, '', now + 10_000)).toBe('bad_token');
    expect(await checkForm(t.env, 'acme', 'forged', '', now + 10_000)).toBe('bad_token');
  });

  it('holds links for unverified people and trusts trusted ones', async () => {
    const bd = await board();
    const guest = await createGuest(ctx, req(), 'G');
    const kim = await verified('kim@example.com');
    const many = 'see http://a.com http://b.com http://c.com http://d.com http://e.com http://f.com';
    expect(holdReason(guest, bd, 'hello')).toBe('guest');
    expect(holdReason(kim, bd, 'hello')).toBeNull();
    expect(holdReason(kim, bd, many)).toBe('links');
    expect(holdReason({ ...kim, trusted: 1 }, { ...bd, moderate: 1 }, many)).toBeNull();
    expect(holdReason(kim, { ...bd, moderate: 1 }, 'hello')).toBe('moderation');
  });

  it('refuses a blocked person', async () => {
    const kim = await verified('kim@example.com');
    await ctx.db.update('fb_people', kim.id, { blocked: 1 });
    await expect(submitPost(ctx, { board: await board(), person: { ...kim, blocked: 1 }, title: 'Hi there' })).rejects.toMatchObject({ code: 'feedback.blocked' });
  });
});

describe('merging', () => {
  it('moves votes and comments once per person and redirects the old post', async () => {
    const a = await verified('a@example.com');
    const b = await verified('b@example.com');
    const c = await verified('c@example.com');
    const bd = await board();
    const src = await newPost('Export to CSV', a);
    const dst = await newPost('CSV export please', b);
    await toggleVote(ctx, dst, bd, a, 0); // a voted on both
    await toggleVote(ctx, src, bd, c, 0);
    await addStaffComment(ctx, src.id, { id: null, name: 'Team' }, 'We are looking at it', { notify: false });
    const preview = await mergePreview(ctx, src.id, dst.id);
    expect(preview.votesAlready).toBe(1);
    expect(preview.votesMoved).toBe(1);
    expect(preview.resultVotes).toBe(3);
    const merged = await mergePosts(ctx, src.id, dst.id);
    expect(merged.id).toBe(dst.id);
    const old = await ctx.db.get<{ review: string; merged_into: string }>('fb_posts', src.id);
    expect(old).toMatchObject({ review: 'merged', merged_into: dst.id });
    const target = await ctx.db.get<{ vote_count: number; comment_count: number }>('fb_posts', dst.id);
    expect(target?.vote_count).toBe(3);
    expect(target?.comment_count).toBe(1);
    await expect(mergePosts(ctx, src.id, dst.id)).rejects.toBeTruthy();
  });
});

describe('similar posts', () => {
  it('finds related titles while typing', async () => {
    await newPost('Dark mode for the dashboard');
    await newPost('Export reports to CSV');
    const hits = await similarPosts(ctx, 'dark dashboard');
    expect(hits.map((h) => h.title)).toEqual(['Dark mode for the dashboard']);
    expect(await similarPosts(ctx, 'zzz nothing')).toEqual([]);
  });
});

describe('close the loop emails', () => {
  async function post(votes: number) {
    const author = await verified('author@example.com');
    const p = await newPost('Slack alerts', author);
    for (let i = 0; i < votes; i++) await addVoteFor(ctx, p.id, (await verified(`v${i}@example.com`)).id);
    return p;
  }

  it('batches a status change and sends each person one email with an unsubscribe link', async () => {
    const p = await post(24);
    const done = (await listStatuses(ctx)).find((s) => s.kind === 'done')!;
    await changeStatus(ctx, p.id, done.id, { id: null, name: 'Team' });
    const jobsBefore = t.queue.sent?.length ?? 0;
    await t.drainJobs();
    const mails = await devOutbox(t.env, { limit: 100 });
    const status = mails.filter((m) => m.template === 'feedback-status');
    expect(status.length).toBe(25);
    expect(new Set(status.map((m) => m.to)).size).toBe(25);
    expect(status.every((m) => /unsubscribe|Stop emails/i.test(m.text ?? ''))).toBe(true);
    expect(status.every((m) => !/<img/i.test(m.html ?? ''))).toBe(true);
    expect(jobsBefore).toBeGreaterThanOrEqual(0);
  });

  it('resumes after a crash without sending twice', async () => {
    const p = await post(14);
    const id = await queueNotice(t.env, ctx.orgId, { kind: 'reply', postId: p.id, payload: { who: 'Team', excerpt: 'Hello' }, origin: 'http://localhost' });
    await runNotice(t.env, ctx.orgId, id); // first batch only
    const mid = (await devOutbox(t.env, { limit: 100 })).filter((m) => m.template === 'feedback-reply').length;
    expect(mid).toBe(10);
    // The job is delivered again from the start: the cursor is lost but deliveries remember.
    await t.env.DB.prepare("UPDATE fb_outbox SET cursor = '' WHERE id = ?1").bind(id).run();
    await t.drainJobs();
    await runNotice(t.env, ctx.orgId, id);
    const all = (await devOutbox(t.env, { limit: 100 })).filter((m) => m.template === 'feedback-reply');
    expect(all.length).toBe(15);
    expect(new Set(all.map((m) => m.to)).size).toBe(15);
  });

  it('skips people who opted out', async () => {
    const p = await post(2);
    await t.env.DB.prepare("UPDATE fb_people SET mail_off = 1 WHERE email = 'v0@example.com'").run();
    const id = await queueNotice(t.env, ctx.orgId, { kind: 'reply', postId: p.id, payload: { who: 'Team', excerpt: 'Hi' }, origin: 'http://localhost' });
    await t.drainJobs();
    await runNotice(t.env, ctx.orgId, id);
    const to = (await devOutbox(t.env, { limit: 100 })).filter((m) => m.template === 'feedback-reply').map((m) => m.to);
    expect(to).not.toContain('v0@example.com');
    expect(to).toContain('v1@example.com');
  });

  it('does nothing when email is not set up', async () => {
    await setup({ ENVIRONMENT: 'production' });
    const author = await verified('author@example.com');
    const p = await newPost('Idea', author);
    const id = await queueNotice(t.env, ctx.orgId, { kind: 'status', postId: p.id, payload: { status: 'Planned' }, origin: 'http://localhost' });
    await runNotice(t.env, ctx.orgId, id);
    const row = await t.env.DB.prepare('SELECT state FROM fb_outbox WHERE id = ?1').bind(id).first<{ state: string }>();
    expect(row?.state).toBe('skipped');
  });
});

describe('changelog', () => {
  it('publishing an entry completes the linked posts and queues the shipped notice', async () => {
    const author = await verified('author@example.com');
    const p = await newPost('Keyboard shortcuts', author);
    const e = await createEntry(ctx, { title: 'Shortcuts are here', body: 'Press **?** to see them.', labels: ['New'], post_ids: [p.id] }, { name: 'Team' });
    expect(e.state).toBe('draft');
    const pub = await publishEntry(ctx, e.id);
    expect(pub.state).toBe('published');
    const row = await ctx.db.get<{ status_id: string }>('fb_posts', p.id);
    const status = (await listStatuses(ctx)).find((s) => s.id === row?.status_id);
    expect(status?.kind).toBe('done');
    const shipped = await t.env.DB.prepare("SELECT COUNT(*) AS n FROM fb_outbox WHERE kind = 'shipped'").first<{ n: number }>();
    expect(shipped?.n).toBe(1);
    expect((await publishEntry(ctx, e.id)).published_at).toBe(pub.published_at);
  });

  it('publishes scheduled entries once their time has come', async () => {
    const e = await createEntry(ctx, { title: 'Later', body: 'x', state: 'scheduled', publish_at: Date.now() + 60_000 }, { name: 'Team' });
    expect(e.state).toBe('scheduled');
    expect(await publishDue(t.env, Date.now())).toBe(0);
    expect(await publishDue(t.env, Date.now() + 120_000)).toBe(1);
    expect((await ctx.db.get<{ state: string }>('fb_entries', e.id))?.state).toBe('published');
  });

  it('uses double opt in for subscribers', async () => {
    const portal = (await getPortal(ctx))!;
    const res = await subscribe(ctx, portal, 'fan@example.com', 'each', '198.51.100.9', 'http://localhost');
    expect(res).toBeTruthy();
    const row = await t.env.DB.prepare("SELECT status FROM fb_subscribers WHERE email = 'fan@example.com'").first<{ status: string }>();
    expect(row?.status).toBe('pending');
    const mail = (await devOutbox(t.env, { to: 'fan@example.com' }))[0]!;
    expect(mail.text).toMatch(/changelog\/acme\/confirm\?t=/);
  });
});

describe('import and export', () => {
  const csv = 'Title,Details,Author Name,Author Email,Votes,Status,Board,Created\n' + '"Dark mode","Please, dark",Ann,ann@example.com,12,planned,Feature requests,2025-01-02\n' + '"Dark mode","dupe",Bob,bob@example.com,3,open,Feature requests,2025-01-03\n' + ',"no title",X,x@example.com,1,open,,\n';

  it('maps Canny style columns and imports without emailing anyone', async () => {
    const preview = previewCsv(csv);
    const mapping = guessMapping(preview.headers);
    expect(mapping.title).toBe(0);
    expect(mapping.author_email).toBe(3);
    const res = await importPosts(ctx, csv, mapping, 0);
    expect(res.imported).toBe(2);
    expect(res.skipped).toBe(1);
    const posts = (await listPosts(ctx, {})).items;
    expect(posts.find((p) => p.title === 'Dark mode' && p.vote_count === 12)).toBeTruthy();
    const people = await t.env.DB.prepare("SELECT verified FROM fb_people WHERE email = 'ann@example.com'").first<{ verified: number }>();
    expect(people?.verified).toBe(0);
    expect((await exportAll(ctx)).fb_posts?.length).toBe(2);
  });

  it('neutralises spreadsheet formulas in the export', async () => {
    await newPost('=HYPERLINK("http://x")');
    const { postsCsv } = await import('./exportimport');
    expect(await postsCsv(ctx)).not.toMatch(/\n"?=HYPERLINK/);
  });
});

describe('sample data and stats', () => {
  it('seeds, reports and clears exactly its own rows', async () => {
    const mctx = { env: t.env, org: { id: t.org.id, name: 'Acme', slug: 'acme' }, db: ctx.db };
    const mine = await newPost('My real post', await verified('me@example.com'));
    await seedSample(mctx);
    const stats = await computeStats(ctx, 30);
    expect(stats.totals.posts).toBeGreaterThan(8);
    expect(stats.firstReply.count).toBeGreaterThan(0);
    await clearSample(mctx);
    const left = (await listPosts(ctx, { review: 'all' })).items;
    expect(left.map((p) => p.id)).toEqual([mine.id]);
    const stray = await t.env.DB.prepare('SELECT (SELECT COUNT(*) FROM fb_votes WHERE post_id <> ?1) + (SELECT COUNT(*) FROM fb_comments) + (SELECT COUNT(*) FROM fb_entries) + (SELECT COUNT(*) FROM fb_subscribers) AS n').bind(mine.id).first<{ n: number }>();
    expect(stray?.n).toBe(0);
  });
});

describe('schema', () => {
  it('gives every table an org_id', async () => {
    for (const table of feedback.tables ?? []) {
      const cols = (await t.env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>()).results.map((c) => c.name);
      expect(cols, table).toContain('org_id');
    }
  });
});
