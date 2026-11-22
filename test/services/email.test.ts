import { describe, expect, it } from 'vitest';
import {
  classifyFailure,
  devOutbox,
  emailStatus,
  getSender,
  isSuppressed,
  listEmailLog,
  listSuppressions,
  purgeEmailLog,
  sendEmail,
  sendTestEmail,
  sendViaBinding,
  setSender,
  unsuppressAddress,
  type BindingMessage,
} from '../../src/core/email';
import { renderEmail } from '../../src/core/email-templates';
import { handleQueue, runJob } from '../../src/core/jobs';
import { INSTANCE, setSetting } from '../../src/core/settings';
import type { JobMessage } from '../../src/env';
import { createTestEnv } from '../helpers/d1';

class CloudflareError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** A stand-in for the EMAIL binding. `behave` decides what each send does. */
function fakeBinding(behave: (msg: BindingMessage, call: number) => unknown = () => ({ messageId: 'cf_1' })) {
  const calls: BindingMessage[] = [];
  return {
    calls,
    async send(msg: BindingMessage) {
      calls.push(msg);
      const out = behave(msg, calls.length);
      if (out instanceof Error) throw out;
      return out as { messageId: string };
    },
  };
}

function liveEnv(binding = fakeBinding(), vars: Record<string, unknown> = {}) {
  const t = createTestEnv({ ENVIRONMENT: 'production', EMAIL: binding as never, ...vars });
  return { ...t, binding };
}

async function setUpSender(env: ReturnType<typeof createTestEnv>['env']) {
  await setSetting(env, INSTANCE, 'email.sender', { fromAddress: 'hello@mail.example.com', fromName: 'Acme' });
}

const mail = (to = 'sam@example.com', extra: Record<string, unknown> = {}) => ({
  to,
  subject: 'Your sign-in link',
  html: '<p>hello</p>',
  text: 'hello',
  template: 'test',
  ...extra,
});

describe('sendViaBinding', () => {
  it('passes the message through and returns the message id', async () => {
    const b = fakeBinding();
    const msg: BindingMessage = { from: { email: 'a@example.com', name: 'A' }, to: 'b@example.com', subject: 's', html: 'h', text: 't' };
    expect(await sendViaBinding(b, msg)).toEqual({ messageId: 'cf_1' });
    expect(b.calls).toEqual([msg]);
  });

  it('copes with a binding that returns nothing', async () => {
    expect(await sendViaBinding({ async send() {} }, {} as BindingMessage)).toEqual({});
  });
});

describe('sendEmail in dev and without setup', () => {
  it('keeps the body in dev and shows it in the outbox', async () => {
    const t = createTestEnv();
    const res = await sendEmail(t.env, mail('Sam@Example.com'));
    expect(res.status).toBe('dev');
    expect(await devOutbox(t.env, { to: 'sam@example.com' })).toMatchObject([{ text: 'hello', html: '<p>hello</p>' }]);
  });

  it('is not_configured in production without a binding', async () => {
    const t = createTestEnv({ ENVIRONMENT: 'production' });
    expect((await sendEmail(t.env, mail())).status).toBe('not_configured');
  });

  it('does not send live while the sender address is empty', async () => {
    const { env, binding } = liveEnv();
    expect((await sendEmail(env, mail())).status).toBe('not_configured');
    expect(binding.calls).toHaveLength(0);
  });

  it('rejects a malformed address and strips line breaks from the subject', async () => {
    const t = createTestEnv();
    expect(await sendEmail(t.env, mail('not an address'))).toMatchObject({ status: 'failed' });
    expect(await sendEmail(t.env, mail('a@example.com\nBcc: b@example.com'))).toMatchObject({ status: 'failed' });
    await sendEmail(t.env, mail('ok@example.com', { subject: 'Hello\r\nBcc: evil@example.com' }));
    const [row] = await devOutbox(t.env, { to: 'ok@example.com' });
    expect(row?.subject).toBe('Hello Bcc: evil@example.com');
  });
});

describe('sendEmail live', () => {
  it('sends through the binding with the saved sender and reply-to', async () => {
    const { env, binding } = liveEnv();
    await setSender(env, { fromName: 'Acme', fromAddress: 'Hello@Mail.Example.com', replyTo: 'help@example.com' });
    const res = await sendEmail(env, mail());
    expect(res).toMatchObject({ status: 'sent', messageId: 'cf_1' });
    expect(binding.calls[0]).toEqual({
      from: { email: 'hello@mail.example.com', name: 'Acme' },
      to: 'sam@example.com',
      subject: 'Your sign-in link',
      html: '<p>hello</p>',
      text: 'hello',
      replyTo: 'help@example.com',
    });
    const log = await listEmailLog(env);
    expect(log.items[0]).toMatchObject({ status: 'sent', messageId: 'cf_1', attempts: 1, template: 'test' });
  });

  it('uses EMAIL_FROM until a sender is saved, and ignores one that is not an address', async () => {
    const { env, binding } = liveEnv();
    expect((await sendEmail(env, mail())).status).toBe('not_configured');
    const deployed = { ...env, EMAIL_FROM: ' Hello@Mail.Example.com ' };
    expect(await getSender(deployed)).toEqual({ fromAddress: 'hello@mail.example.com', fromName: 'Toolshed' });
    expect(await emailStatus(deployed)).toEqual({ status: 'ready', mode: 'live' });
    expect((await sendEmail(deployed, mail())).status).toBe('sent');
    expect(binding.calls[0]?.from).toEqual({ email: 'hello@mail.example.com', name: 'Toolshed' });

    for (const bad of ['not-an-address', 'a@b', 'x@example.com\nBcc: y@example.com', '']) {
      expect((await getSender({ ...env, EMAIL_FROM: bad })).fromAddress).toBe('');
    }

    // A saved sender wins, and clearing it on the Email screen still turns sending off.
    await setSender(deployed, { fromName: 'Acme', fromAddress: 'team@mail.example.com' });
    expect((await getSender(deployed)).fromAddress).toBe('team@mail.example.com');
    await setSender(deployed, { fromName: 'Acme', fromAddress: '' });
    expect((await getSender(deployed)).fromAddress).toBe('');
    expect((await sendEmail(deployed, mail())).status).toBe('not_configured');
  });

  it('a message replyTo wins over the saved one', async () => {
    const { env, binding } = liveEnv();
    await setSender(env, { fromName: 'Acme', fromAddress: 'hello@mail.example.com', replyTo: 'help@example.com' });
    await sendEmail(env, mail('sam@example.com', { replyTo: 'maya@example.com' }));
    expect(binding.calls[0]?.replyTo).toBe('maya@example.com');
  });

  it('never stores bodies, codes or links in production', async () => {
    const { env } = liveEnv();
    await setUpSender(env);
    const rendered = await renderEmail(env, {
      template: 'sign-in-code',
      data: { code: '482913', minutes: 10, link: 'https://tools.example.com/sign-in/verify?t=SECRETTOKEN' },
    });
    const res = await sendEmail(env, { to: 'sam@example.com', ...rendered, template: 'sign-in-code' });
    expect(res.status).toBe('sent');
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM email_log').all()).results);
    expect(dump).not.toContain('482913');
    expect(dump).not.toContain('SECRETTOKEN');
    const row = await env.DB.prepare('SELECT body_text, body_html FROM email_log').first();
    expect(row).toEqual({ body_text: null, body_html: null });
  });

  it('keeps a failed message out of the log too', async () => {
    const { env } = liveEnv(fakeBinding(() => new CloudflareError('E_SENDER_NOT_VERIFIED')));
    await setUpSender(env);
    await sendEmail(env, mail('sam@example.com', { text: 'CODE-111222' }));
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM email_log').all()).results);
    expect(dump).not.toContain('CODE-111222');
  });

  it('fails at once, without a retry, when the sender is not set up', async () => {
    const t = liveEnv(fakeBinding(() => new CloudflareError('E_SENDER_NOT_VERIFIED', 'domain not verified')));
    await setUpSender(t.env);
    const res = await sendEmail(t.env, mail());
    expect(res.status).toBe('failed');
    expect(res.error).toContain('Email screen');
    expect(t.queue.sent).toHaveLength(0);
  });

  it('fails at once for a malformed argument (TypeError)', async () => {
    const t = liveEnv(fakeBinding(() => new TypeError('bad argument')));
    await setUpSender(t.env);
    expect((await sendEmail(t.env, mail())).status).toBe('failed');
    expect(t.queue.sent).toHaveLength(0);
  });
});

describe('classifyFailure', () => {
  it('sorts Cloudflare errors into bounce, permanent and transient', () => {
    expect(classifyFailure(new CloudflareError('E_RECIPIENT_SUPPRESSED')).kind).toBe('bounce');
    expect(classifyFailure(new CloudflareError('E_DELIVERY_FAILED', '550 5.1.1 no such user')).kind).toBe('bounce');
    expect(classifyFailure(new CloudflareError('E_DELIVERY_FAILED', '421 try again later')).kind).toBe('transient');
    expect(classifyFailure(new CloudflareError('E_VALIDATION_ERROR')).kind).toBe('permanent');
    expect(classifyFailure(new CloudflareError('E_SENDER_DOMAIN_NOT_AVAILABLE')).kind).toBe('permanent');
    expect(classifyFailure(new CloudflareError('E_RECIPIENT_NOT_ALLOWED')).kind).toBe('permanent');
    expect(classifyFailure(new CloudflareError('E_CONTENT_TOO_LARGE')).kind).toBe('permanent');
    expect(classifyFailure(new CloudflareError('E_RATE_LIMIT_EXCEEDED')).kind).toBe('transient');
    expect(classifyFailure(new CloudflareError('E_INTERNAL_SERVER_ERROR')).kind).toBe('transient');
    expect(classifyFailure(new Error('network down')).kind).toBe('transient');
    expect(classifyFailure(new TypeError('x')).kind).toBe('permanent');
  });
});

describe('retry', () => {
  it('queues a retry with a delay, then marks the log sent when it works', async () => {
    const t = liveEnv(fakeBinding((_m, call) => (call === 1 ? new CloudflareError('E_INTERNAL_SERVER_ERROR') : { messageId: 'cf_2' })));
    await setUpSender(t.env);
    const res = await sendEmail(t.env, mail());
    expect(res.status).toBe('retrying');
    expect(t.queue.sent).toHaveLength(1);
    expect(t.queue.sent[0]).toMatchObject({ body: { name: 'core.email-retry' }, delaySeconds: 30 });

    await runJob(t.env, t.queue.sent.shift()!.body, 1);
    expect(t.binding.calls).toHaveLength(2);
    const [row] = (await listEmailLog(t.env)).items;
    expect(row).toMatchObject({ id: res.id, status: 'sent', attempts: 2, messageId: 'cf_2', error: null });
  });

  it('keeps retrying, then gives up after the last attempt and records the failure without the message', async () => {
    const t = liveEnv(fakeBinding(() => new CloudflareError('E_INTERNAL_SERVER_ERROR')));
    await setUpSender(t.env);
    const res = await sendEmail(t.env, mail('sam@example.com', { text: 'CODE-999888' }));
    const job = t.queue.sent.shift()!.body as JobMessage;

    const retries: number[] = [];
    let acked = 0;
    for (let attempts = 1; attempts <= 5; attempts++) {
      await handleQueue(
        {
          messages: [
            {
              body: job,
              attempts,
              ack: () => void acked++,
              retry: (o?: { delaySeconds?: number }) => void retries.push(o?.delaySeconds ?? 0),
            },
          ],
        } as never,
        t.env,
      );
    }
    expect(retries).toEqual([30, 60, 120, 240]);
    expect(acked).toBe(1);

    const [row] = (await listEmailLog(t.env)).items;
    expect(row).toMatchObject({ id: res.id, status: 'failed', attempts: 6 });
    expect(row?.error).toContain('Gave up');

    const failure = await t.env.DB.prepare('SELECT name, payload, payload_preview FROM job_failures').first<{ name: string; payload: string | null; payload_preview: string }>();
    expect(failure?.name).toBe('core.email-retry');
    expect(failure?.payload).toBeNull();
    expect(failure?.payload_preview).toBe('[hidden]');
    expect(JSON.stringify((await t.env.DB.prepare('SELECT * FROM job_failures').all()).results)).not.toContain('CODE-999888');
  });

  it('stops at once on a permanent error during a retry', async () => {
    const t = liveEnv(fakeBinding((_m, call) => (call === 1 ? new CloudflareError('E_INTERNAL_SERVER_ERROR') : new CloudflareError('E_VALIDATION_ERROR'))));
    await setUpSender(t.env);
    await sendEmail(t.env, mail());
    await runJob(t.env, t.queue.sent.shift()!.body, 1);
    expect((await listEmailLog(t.env)).items[0]?.status).toBe('failed');
    expect(t.queue.sent).toHaveLength(0);
  });
});

describe('suppression', () => {
  it('suppresses an address that hard-bounces and stops sending to it', async () => {
    const t = liveEnv(fakeBinding(() => new CloudflareError('E_DELIVERY_FAILED', '550 5.1.1 user unknown')));
    await setUpSender(t.env);
    expect((await sendEmail(t.env, mail('gone@example.com'))).status).toBe('failed');
    expect(await isSuppressed(t.env, 'GONE@example.com')).toBe(true);
    expect(await listSuppressions(t.env)).toMatchObject([{ address: 'gone@example.com' }]);

    const calls = t.binding.calls.length;
    const again = await sendEmail(t.env, mail('gone@example.com'));
    expect(again.status).toBe('suppressed');
    expect(t.binding.calls.length).toBe(calls);
  });

  it('suppresses when Cloudflare says the address is suppressed', async () => {
    const t = liveEnv(fakeBinding(() => new CloudflareError('E_RECIPIENT_SUPPRESSED')));
    await setUpSender(t.env);
    await sendEmail(t.env, mail('x@example.com'));
    expect(await isSuppressed(t.env, 'x@example.com')).toBe(true);
  });

  it('does not suppress on a soft failure', async () => {
    const t = liveEnv(fakeBinding(() => new CloudflareError('E_DELIVERY_FAILED', '421 mailbox busy')));
    await setUpSender(t.env);
    expect((await sendEmail(t.env, mail('slow@example.com'))).status).toBe('retrying');
    expect(await isSuppressed(t.env, 'slow@example.com')).toBe(false);
  });

  it('can be lifted again, and that is audited', async () => {
    const t = liveEnv();
    await setUpSender(t.env);
    await t.env.DB.prepare("INSERT INTO email_suppressions (address, org_id, reason, created_at) VALUES ('a@example.com', '', 'bounce', 1)").run();
    expect(await unsuppressAddress(t.env, 'A@example.com', { id: 'usr_1', email: 'owner@example.com' })).toBe(true);
    expect(await unsuppressAddress(t.env, 'a@example.com')).toBe(false);
    expect((await sendEmail(t.env, mail('a@example.com'))).status).toBe('sent');
    const row = await t.env.DB.prepare("SELECT action FROM audit_log WHERE action = 'email.suppression_removed'").first();
    expect(row).not.toBeNull();
  });
});

describe('caps', () => {
  it('limits emails per recipient per hour', async () => {
    const t = liveEnv();
    await setUpSender(t.env);
    await setSetting(t.env, INSTANCE, 'email.caps', { perRecipientPerHour: 2, perInstallPerHour: 100 });
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await sendEmail(t.env, mail('sam@example.com'))).status);
    expect(statuses).toEqual(['sent', 'sent', 'capped', 'capped']);
    expect((await sendEmail(t.env, mail('other@example.com'))).status).toBe('sent');
    expect(t.binding.calls).toHaveLength(3);
  });

  it('limits emails per install per hour', async () => {
    const t = liveEnv();
    await setUpSender(t.env);
    await setSetting(t.env, INSTANCE, 'email.caps', { perRecipientPerHour: 100, perInstallPerHour: 3 });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await sendEmail(t.env, mail(`u${i}@example.com`))).status);
    expect(statuses).toEqual(['sent', 'sent', 'sent', 'capped', 'capped']);
    const { items } = await listEmailLog(t.env);
    expect(items.some((row) => row.error?.includes('hourly email limit'))).toBe(true);
  });

  it('has sensible defaults', async () => {
    const t = liveEnv();
    await setUpSender(t.env);
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await sendEmail(t.env, mail())).status);
    expect(statuses.filter((s) => s === 'sent')).toHaveLength(10);
    expect(statuses.filter((s) => s === 'capped')).toHaveLength(2);
  });
});

describe('sender and status', () => {
  it('reports each mode with a reason and a next step', async () => {
    const dev = createTestEnv();
    expect(await emailStatus(dev.env)).toMatchObject({ status: 'ready', mode: 'dev' });

    const none = createTestEnv({ ENVIRONMENT: 'production' });
    const off = await emailStatus(none.env);
    expect(off).toMatchObject({ status: 'needs_setup', mode: 'off' });
    expect(off.reason).toBeTruthy();
    expect(off.action?.label).toBeTruthy();

    const bound = liveEnv();
    const noSender = await emailStatus(bound.env);
    expect(noSender).toMatchObject({ status: 'needs_setup', mode: 'off' });
    expect(noSender.reason).toContain('address');

    await setUpSender(bound.env);
    expect(await emailStatus(bound.env)).toEqual({ status: 'ready', mode: 'live' });
  });

  it('validates and saves the sender, and writes an audit row', async () => {
    const t = createTestEnv();
    expect(await getSender(t.env)).toEqual({ fromAddress: '', fromName: 'Toolshed' });
    await expect(setSender(t.env, { fromName: '', fromAddress: 'nope' })).rejects.toMatchObject({
      code: 'validation_failed',
      fields: { fromName: expect.any(String), fromAddress: expect.any(String) },
    });
    await expect(setSender(t.env, { fromName: 'Evil\nBcc: x', fromAddress: 'a@example.com' })).rejects.toMatchObject({ code: 'validation_failed' });
    const saved = await setSender(t.env, { fromName: ' Acme ', fromAddress: 'Hello@Example.com', replyTo: '' }, { id: 'usr_1', email: 'owner@example.com' });
    expect(saved).toEqual({ fromName: 'Acme', fromAddress: 'hello@example.com' });
    expect(await getSender(t.env)).toEqual(saved);
    const row = await t.env.DB.prepare("SELECT actor_id, summary FROM audit_log WHERE action = 'email.sender_changed'").first<{ actor_id: string; summary: string }>();
    expect(row?.actor_id).toBe('usr_1');
    expect(row?.summary).toContain('hello@example.com');
  });
});

describe('sendTestEmail', () => {
  it('needs setup when email is off', async () => {
    const t = createTestEnv({ ENVIRONMENT: 'production' });
    await expect(sendTestEmail(t.env, 'me@example.com', { id: 'usr_1' })).rejects.toMatchObject({ code: 'needs_setup' });
  });

  it('rejects a bad address', async () => {
    const t = createTestEnv();
    await expect(sendTestEmail(t.env, 'nope', { id: 'usr_1' })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('sends the test template and audits it', async () => {
    const t = liveEnv();
    await setUpSender(t.env);
    const res = await sendTestEmail(t.env, 'Me@Example.com', { id: 'usr_1', email: 'owner@example.com', orgId: t.org.id });
    expect(res.status).toBe('sent');
    expect(t.binding.calls[0]).toMatchObject({ to: 'me@example.com' });
    expect(t.binding.calls[0]?.subject.length).toBeGreaterThan(0);
    const audit = await t.env.DB.prepare("SELECT org_id, summary FROM audit_log WHERE action = 'email.test_sent'").first<{ org_id: string; summary: string }>();
    expect(audit).toMatchObject({ org_id: t.org.id });
  });

  it('works in dev mode and is rate limited', async () => {
    const t = createTestEnv();
    for (let i = 0; i < 5; i++) expect((await sendTestEmail(t.env, 'me@example.com', { id: 'usr_1' })).status).toBe('dev');
    await expect(sendTestEmail(t.env, 'me@example.com', { id: 'usr_1' })).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(sendTestEmail(t.env, 'me@example.com', { id: 'usr_2' })).resolves.toBeTruthy();
  });
});

describe('listEmailLog', () => {
  async function seed(t: ReturnType<typeof createTestEnv>, n: number) {
    const stmt = t.env.DB.prepare(
      `INSERT INTO email_log (id, org_id, to_addr, subject, template, status, created_at) VALUES (?1, ?2, ?3, ?4, 'test', ?5, ?6)`,
    );
    const now = Date.now();
    for (let i = 0; i < n; i++) {
      await stmt.bind(`eml_${String(i).padStart(4, '0')}`, i % 5 === 0 ? 'org_other' : t.org.id, `person${i}@example.com`, i % 7 === 0 ? 'Weekly 100% report' : `Hello ${i}`, i % 3 === 0 ? 'failed' : 'sent', now - Math.floor(i / 2) * 1000).run();
    }
  }

  it('pages through every row once, newest first', async () => {
    const t = createTestEnv();
    await seed(t, 25);
    const seen: string[] = [];
    let before: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listEmailLog(t.env, { limit: 10, ...(before ? { before } : {}) });
      seen.push(...page.items.map((i) => i.id));
      if (!page.nextCursor) break;
      before = page.nextCursor;
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });

  it('filters by workspace, status and text, and counts by status', async () => {
    const t = createTestEnv();
    await seed(t, 25);
    const mine = await listEmailLog(t.env, { orgId: t.org.id, limit: 200 });
    expect(mine.items.every((i) => i.orgId === t.org.id)).toBe(true);
    expect(mine.items).toHaveLength(20);
    expect(mine.counts.failed! + mine.counts.sent!).toBe(20);
    expect(mine.counts.retrying).toBe(0);

    const failed = await listEmailLog(t.env, { orgId: t.org.id, status: 'failed', limit: 200 });
    expect(failed.items.every((i) => i.status === 'failed')).toBe(true);

    const percent = await listEmailLog(t.env, { q: '100%', limit: 200 });
    expect(percent.items.length).toBeGreaterThan(0);
    expect(percent.items.every((i) => i.subject.includes('100%'))).toBe(true);
    expect((await listEmailLog(t.env, { q: '%', limit: 200 })).items.every((i) => i.subject.includes('%'))).toBe(true);
    expect((await listEmailLog(t.env, { q: 'person3@', limit: 200 })).items).toHaveLength(1);
  });

  it('rejects a cursor that is not ours', async () => {
    const t = createTestEnv();
    await expect(listEmailLog(t.env, { before: 'garbage' })).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('log retention', () => {
  it('deletes only rows older than the retention', async () => {
    const t = createTestEnv();
    const day = 86_400_000;
    const now = Date.UTC(2026, 10, 21);
    const insert = (id: string, age: number) =>
      t.env.DB.prepare("INSERT INTO email_log (id, to_addr, subject, status, created_at) VALUES (?1, 'a@example.com', 's', 'sent', ?2)").bind(id, now - age * day).run();
    await insert('old', 31);
    await insert('edge', 29);
    await insert('new', 1);
    expect(await purgeEmailLog(t.env, now)).toBe(1);
    expect((await listEmailLog(t.env)).items.map((i) => i.id).sort()).toEqual(['edge', 'new']);
    await setSetting(t.env, INSTANCE, 'email.logRetentionDays', 7);
    expect(await purgeEmailLog(t.env, now)).toBe(1);
  });
});
