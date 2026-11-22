import { describe, expect, it } from 'vitest';
import { confirmSubscription, CONFIRM_RESEND_MS, exportSubscribersCsv, importSubscribers, joinList, querySubscribers, unsubscribe } from './subscribers';
import { importBounced, isSuppressed, recordBounce, recordComplaint, removeSuppression, listSuppressions } from './suppression';
import { readConfirmToken, readUnsubscribeToken } from './tokens';
import { DAY, fixture, HOUR, MIN, T0 } from './testkit';

const base = 'http://localhost';

describe('double opt-in', () => {
  it('keeps a new signup pending until the link is used, and the confirm email carries no marketing', async () => {
    const f = await fixture();
    const r = await joinList(f.ctx, f.list, { email: 'Sam@Example.com', name: 'Sam' }, { base, sender: f.sender, now: T0 });
    expect(r.outcome).toBe('pending');
    expect(f.sender.sent).toHaveLength(1);
    const mail = f.sender.sent[0]!;
    expect(mail.to).toBe('sam@example.com');
    expect(mail.tag).toBe('mail.confirm');
    expect(mail.headers).toBeUndefined();
    expect(mail.text).not.toMatch(/unsubscribe/i);
    const url = /(http:\/\/localhost\/n\/confirm\/[^\s"<]+)/.exec(mail.text)![1]!;
    const token = url.split('/').pop()!;
    const t = (await readConfirmToken(f.t.env, token, T0 + MIN))!;
    expect(t.s).toBe(r.subscriber!.id);
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'active' }, T0)).total).toBe(0);
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'pending' }, T0)).total).toBe(1);

    const done = await confirmSubscription(f.ctx, t, T0 + 2 * MIN);
    expect(done?.subscriber.email).toBe('sam@example.com');
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'active' }, T0)).total).toBe(1);
    // Using the link again is harmless.
    expect(await confirmSubscription(f.ctx, t, T0 + 3 * MIN)).not.toBeNull();
  });

  it('a confirm link stops working after a week, and a tampered one never works', async () => {
    const f = await fixture();
    const r = await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 });
    const token = /confirm\/([^\s"<]+)/.exec(f.sender.sent[0]!.text)![1]!;
    expect(await readConfirmToken(f.t.env, token, Date.now() + 6 * DAY)).not.toBeNull();
    expect(await readConfirmToken(f.t.env, token, Date.now() + 8 * DAY)).toBeNull();
    const bad = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(await readConfirmToken(f.t.env, bad, T0)).toBeNull();
    expect(r.outcome).toBe('pending');
  });

  it('sends the confirm email at most once every ten minutes per person', async () => {
    const f = await fixture();
    await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 });
    await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 + MIN });
    expect(f.sender.sent).toHaveLength(1);
    await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 + CONFIRM_RESEND_MS + MIN });
    expect(f.sender.sent).toHaveLength(2);
  });

  it('answers a stranger the same way for known, new and blocked addresses', async () => {
    const f = await fixture();
    await joinList(f.ctx, f.list, { email: 'known@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    await recordBounce(f.ctx, 'blocked@example.com', '', T0);
    const a = await joinList(f.ctx, f.list, { email: 'known@example.com' }, { base, sender: f.sender, now: T0 });
    const b = await joinList(f.ctx, f.list, { email: 'blocked@example.com' }, { base, sender: f.sender, now: T0 });
    expect(a.outcome).toBe('active');
    expect(b.outcome).toBe('blocked');
    expect(f.sender.sent.filter((m) => m.to === 'blocked@example.com')).toHaveLength(0);
  });

  it('an unsubscribed person can sign up again, and it is a fresh confirmation', async () => {
    const f = await fixture();
    const r = await joinList(f.ctx, f.list, { email: 'a@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    await unsubscribe(f.ctx, { s: r.subscriber!.id, l: f.list.id }, 'unsubscribed', T0 + MIN);
    expect((await isSuppressed(f.ctx, 'a@example.com', f.list.id))?.reason).toBe('unsubscribed');
    const again = await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 + HOUR });
    expect(again.outcome).toBe('pending');
    const token = /confirm\/([^\s"<]+)/.exec(f.sender.sent.at(-1)!.text)![1]!;
    await confirmSubscription(f.ctx, (await readConfirmToken(f.t.env, token, T0 + HOUR))!, T0 + HOUR + MIN);
    expect(await isSuppressed(f.ctx, 'a@example.com', f.list.id)).toBeNull();
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'active' }, T0)).total).toBe(1);
  });

  it('single opt-in lists activate straight away', async () => {
    const f = await fixture({ doubleOptIn: false });
    const r = await joinList(f.ctx, f.list, { email: 'a@example.com' }, { base, sender: f.sender, now: T0 });
    expect(r.outcome).toBe('active');
    expect(f.sender.sent).toHaveLength(0);
  });
});

describe('import', () => {
  const csv = 'email,name,plan\nada@example.com,Ada,pro\nbad-address,Bob,free\nADA@example.com,Ada again,pro\nbounced@example.com,Cy,free\ngone@example.com,Di,free\nnew@example.com,Eve,\n';

  it('needs the consent box, and never sends a confirmation', async () => {
    const f = await fixture();
    await expect(importSubscribers(f.ctx, { listId: f.list.id, csv, consent: false }, T0)).rejects.toThrow();
    await recordBounce(f.ctx, 'bounced@example.com', '', T0);
    const s = await joinList(f.ctx, f.list, { email: 'gone@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    await unsubscribe(f.ctx, { s: s.subscriber!.id, l: f.list.id }, 'unsubscribed', T0);
    const report = await importSubscribers(f.ctx, { listId: f.list.id, csv, consent: true }, T0 + MIN);
    expect(report.added).toBe(2); // ada and new
    expect(report.invalid).toBe(1);
    expect(report.duplicates_in_file).toBe(1);
    expect(report.suppressed).toBe(2); // bounced and unsubscribed
    expect(f.sender.sent.filter((m) => m.tag === 'mail.confirm')).toHaveLength(0);
    const active = await querySubscribers(f.ctx, { listId: f.list.id, status: 'active' }, T0);
    expect(active.items.map((i) => i.email).sort()).toEqual(['ada@example.com', 'new@example.com']);
    expect(active.items.find((i) => i.email === 'ada@example.com')!.consent_note).toMatch(/import/i);
  });

  it('suppression survives a re-import', async () => {
    const f = await fixture();
    await importSubscribers(f.ctx, { listId: f.list.id, csv: 'email\nx@example.com\n', consent: true }, T0);
    const sub = f.t.sqlite.prepare("SELECT id FROM mail_subscribers WHERE email = 'x@example.com'").get() as { id: string };
    await unsubscribe(f.ctx, { s: sub.id, l: f.list.id }, 'unsubscribed', T0 + MIN);
    const second = await importSubscribers(f.ctx, { listId: f.list.id, csv: 'email\nx@example.com\n', consent: true }, T0 + HOUR);
    expect(second.added).toBe(0);
    expect(second.suppressed).toBe(1);
    expect((await querySubscribers(f.ctx, { listId: f.list.id, status: 'active' }, T0)).total).toBe(0);
  });
});

describe('suppression and bounces', () => {
  it('a bounce or complaint blocks every newsletter, and can be removed by hand', async () => {
    const f = await fixture();
    await joinList(f.ctx, f.list, { email: 'a@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    await recordBounce(f.ctx, 'a@example.com', 'hard bounce', T0);
    await recordComplaint(f.ctx, 'b@example.com', 'spam report', T0);
    const found = await isSuppressed(f.ctx, 'a@example.com', 'any-other-list');
    expect(found?.reason).toBe('bounced');
    const rows = await listSuppressions(f.ctx, {});
    expect(rows.map((r) => r.reason).sort()).toEqual(['bounced', 'complaint']);
    expect(await removeSuppression(f.ctx, rows[0]!.id)).toBe(true);
  });

  it('imports a list of bounced addresses and counts what it did', async () => {
    const f = await fixture();
    const r = await importBounced(f.ctx, ['a@example.com', 'a@example.com', 'nope', 'b@example.com'], T0);
    expect(r).toMatchObject({ added: 2, already: 1, invalid: 1, total: 4 });
    const again = await importBounced(f.ctx, ['a@example.com'], T0 + MIN);
    expect(again.added).toBe(0);
  });
});

describe('export', () => {
  it('exports a list as CSV with status, escaping commas and formulas', async () => {
    const f = await fixture();
    await joinList(f.ctx, f.list, { email: 'a@example.com', name: '=SUM(A1)', confirmed: true }, { base, sender: f.sender, now: T0 });
    const csv = await exportSubscribersCsv(f.ctx, { listId: f.list.id });
    expect(csv.split('\n')[0]).toMatch(/email/);
    expect(csv).toContain('a@example.com');
    expect(csv).not.toContain(',=SUM');
  });
});

describe('unsubscribe tokens', () => {
  it('reject tampering and tokens made for another purpose', async () => {
    const f = await fixture();
    const r = await joinList(f.ctx, f.list, { email: 'a@example.com', confirmed: true }, { base, sender: f.sender, now: T0 });
    const { unsubscribeToken, confirmToken } = await import('./tokens');
    const tok = await unsubscribeToken(f.t.env, { o: f.t.org.id, s: r.subscriber!.id, l: f.list.id });
    expect((await readUnsubscribeToken(f.t.env, tok))?.s).toBe(r.subscriber!.id);
    const flipped = tok.slice(0, -1) + (tok.endsWith('A') ? 'B' : 'A');
    expect(await readUnsubscribeToken(f.t.env, flipped)).toBeNull();
    const [payload, sig] = tok.split('.');
    expect(await readUnsubscribeToken(f.t.env, `${payload}x.${sig}`)).toBeNull();
    expect(await readUnsubscribeToken(f.t.env, 'garbage')).toBeNull();
    const c = await confirmToken(f.t.env, { o: f.t.org.id, s: r.subscriber!.id, l: f.list.id });
    expect(await readUnsubscribeToken(f.t.env, c)).toBeNull();
  });
});
