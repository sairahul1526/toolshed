import { describe, expect, it } from 'vitest';
import { addFeed, checkFeed, listFeeds } from './rss';
import { parseFeed } from './feed-parse';
import { runSequences, saveSequence } from './sequences';
import { joinList } from './subscribers';
import { unsubscribe } from './subscribers';
import { DAY, fixture, HOUR, MIN, T0 } from './testkit';

const base = 'http://localhost';

describe('welcome sequence timing', () => {
  async function setup() {
    const f = await fixture();
    await saveSequence(f.ctx, f.list.id, {
      status: 'active',
      steps: [
        { delay_minutes: 0, subject: 'Welcome {{first_name|there}}', body: 'Hi, glad you are here.' },
        { delay_minutes: 2 * 24 * 60, subject: 'Day two', body: 'A tip.' },
        { delay_minutes: 3 * 24 * 60, subject: 'Day five', body: 'Another tip.' },
      ],
    }, T0);
    return f;
  }

  it('sends each step when its delay has passed, never early, and emits sequence.completed once', async () => {
    const f = await setup();
    await joinList(f.ctx, f.list, { email: 'a@example.com', name: 'Ada', confirmed: true }, { base, sender: f.sender, now: T0 });
    expect((await runSequences(f.t.env, T0 - MIN, { sender: f.sender })).sent).toBe(0);
    expect((await runSequences(f.t.env, T0, { sender: f.sender })).sent).toBe(1);
    expect(f.sender.sent.at(-1)!.subject).toBe('Welcome Ada');
    expect((await runSequences(f.t.env, T0 + DAY, { sender: f.sender })).sent).toBe(0);
    expect((await runSequences(f.t.env, T0 + 2 * DAY, { sender: f.sender })).sent).toBe(1);
    expect(f.sender.sent.at(-1)!.subject).toBe('Day two');
    expect((await runSequences(f.t.env, T0 + 4 * DAY, { sender: f.sender })).sent).toBe(0);
    const last = await runSequences(f.t.env, T0 + 5 * DAY, { sender: f.sender });
    expect(last).toMatchObject({ sent: 1, completed: 1 });
    expect((await runSequences(f.t.env, T0 + 30 * DAY, { sender: f.sender })).sent).toBe(0);
    expect(f.sender.sent).toHaveLength(3);
    const done = f.t.sqlite.prepare("SELECT COUNT(*) AS n FROM events_recent WHERE name = 'sequence.completed'").get() as { n: number };
    expect(done.n).toBe(1);
  });

  it('stops for someone who unsubscribes part way through', async () => {
    const f = await setup();
    const r = await joinList(f.ctx, f.list, { email: 'a@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    await runSequences(f.t.env, T0, { sender: f.sender });
    await unsubscribe(f.ctx, { s: r.subscriber!.id, l: f.list.id }, 'unsubscribed', T0 + HOUR);
    await runSequences(f.t.env, T0 + 3 * DAY, { sender: f.sender });
    expect(f.sender.sent).toHaveLength(1);
  });

  it('does not send a step twice when a crash comes after the send', async () => {
    const f = await setup();
    await joinList(f.ctx, f.list, { email: 'a@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    // The message leaves, then the process dies before the database is told.
    const real = f.sender.send.bind(f.sender);
    let dies = true;
    f.sender.send = async (m) => {
      const r = await real(m);
      if (dies) {
        dies = false;
        throw new Error('process killed');
      }
      return r;
    };
    await expect(runSequences(f.t.env, T0, { sender: f.sender })).rejects.toThrow();
    expect(f.sender.sent).toHaveLength(1);
    // The claim lease must pass before another run may take it.
    await runSequences(f.t.env, T0 + 10 * MIN, { sender: f.sender });
    expect(f.sender.sent.filter((m) => m.subject.startsWith('Welcome'))).toHaveLength(1);
  });

  it('allows at most ten steps', async () => {
    const f = await fixture();
    const steps = Array.from({ length: 11 }, (_, i) => ({ delay_minutes: i, subject: `s${i}`, body: 'b' }));
    await expect(saveSequence(f.ctx, f.list.id, { steps }, T0)).rejects.toThrow();
  });
});

const rss = (items: { id: string; title: string }[]) =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>${items
    .map((i) => `<item><guid>${i.id}</guid><title>${i.title}</title><link>https://example.com/${i.id}</link><description>About ${i.title}</description></item>`)
    .join('')}</channel></rss>`;

describe('rss to email', () => {
  it('parses RSS and Atom', () => {
    expect(parseFeed(rss([{ id: 'a', title: 'One' }])).items[0]).toMatchObject({ key: 'a', title: 'One', link: 'https://example.com/a' });
    const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><title>T</title><entry><id>x1</id><title>Hello &amp; bye</title><link href="https://example.com/x1"/><summary>S</summary></entry></feed>';
    expect(parseFeed(atom).items[0]).toMatchObject({ key: 'x1', title: 'Hello & bye', link: 'https://example.com/x1' });
  });

  it('records the first check as a baseline, then makes one draft per new post and never repeats', async () => {
    const f = await fixture();
    let xml = rss([{ id: 'a', title: 'One' }, { id: 'b', title: 'Two' }]);
    const fetcher = async () => new Response(xml, { status: 200 });
    const feed = await addFeed(f.ctx, { list_id: f.list.id, url: 'https://example.com/feed.xml', mode: 'draft' }, fetcher, T0);
    const count = () => (f.t.sqlite.prepare('SELECT COUNT(*) AS n FROM mail_broadcasts').get() as { n: number }).n;
    expect(count()).toBe(0);
    expect(feed.title).toBe('Blog');

    expect(await checkFeed(f.ctx, (await listFeeds(f.ctx))[0]!, T0 + HOUR, fetcher)).toMatchObject({ added: 0, created: 0 });
    xml = rss([{ id: 'c', title: 'Three' }, { id: 'a', title: 'One' }, { id: 'b', title: 'Two' }]);
    expect(await checkFeed(f.ctx, (await listFeeds(f.ctx))[0]!, T0 + 2 * HOUR, fetcher)).toMatchObject({ added: 1, created: 1 });
    expect(await checkFeed(f.ctx, (await listFeeds(f.ctx))[0]!, T0 + 3 * HOUR, fetcher)).toMatchObject({ added: 0, created: 0 });
    expect(count()).toBe(1);
    const b = f.t.sqlite.prepare('SELECT subject, status FROM mail_broadcasts').get() as { subject: string; status: string };
    expect(b).toEqual({ subject: 'Three', status: 'draft' });
  });

  it('keeps a bad feed from breaking anything and records the reason', async () => {
    const f = await fixture();
    const bad = async () => new Response('nope', { status: 500 });
    const feed = await addFeed(f.ctx, { list_id: f.list.id, url: 'https://example.com/feed.xml', mode: 'draft' }, bad, T0);
    expect(feed.last_error).toMatch(/500/);
    await expect(addFeed(f.ctx, { list_id: f.list.id, url: 'http://localhost/feed', mode: 'draft' }, bad, T0)).rejects.toThrow();
  });
});
