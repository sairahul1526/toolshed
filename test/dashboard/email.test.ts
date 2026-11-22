import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { devOutbox, getSender, isSuppressed, suppressAddress } from '../../src/core/email';
import { INSTANCE, setSetting } from '../../src/core/settings';
import email from '../../src/dashboard/email';
import type { BindingMessage } from '../../src/core/email';
import { createTestSession, type TestSession } from '../helpers/auth';
import { createTestEnv, type TestEnv } from '../helpers/d1';

const app = createApp({ screens: { email } });

function binding(behave: () => unknown = () => ({ messageId: 'cf_1' })) {
  const calls: BindingMessage[] = [];
  return {
    calls,
    async send(msg: BindingMessage) {
      calls.push(msg);
      const out = behave();
      if (out instanceof Error) throw out;
      return out;
    },
  };
}

class CloudflareError extends Error {
  constructor(
    readonly code: string,
    message = code,
  ) {
    super(message);
  }
}

/** A fresh install in dev mode (the default), with the people who might open the screen. */
async function setup(vars: Parameters<typeof createTestEnv>[0] = {}) {
  const t = createTestEnv(vars);
  const owner = await createTestSession(t.env, { role: 'owner', instanceOwner: true, email: 'owner@example.com' });
  const admin = await createTestSession(t.env, { role: 'admin', email: 'admin@example.com' });
  const member = await createTestSession(t.env, { role: 'member', email: 'member@example.com' });
  const viewer = await createTestSession(t.env, { role: 'viewer', email: 'viewer@example.com' });
  return { t, owner, admin, member, viewer };
}

const get = (t: TestEnv, who: TestSession | null, path = '/app/email') => app.request(path, { headers: who?.headers ?? {} }, t.env);

function post(t: TestEnv, who: TestSession, path: string, fields: Record<string, string>) {
  return app.request(
    path,
    { method: 'POST', headers: { ...who.headers, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() },
    t.env,
  );
}

const flashOf = (res: Response) => {
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('ts_flash='))?.split(';')[0]?.slice('ts_flash='.length);
  return raw ? (JSON.parse(decodeURIComponent(decodeURIComponent(raw))) as { kind: string; message: string }) : null;
};

const auditCount = async (t: TestEnv, action: string) => Number(await t.env.DB.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1').bind(action).first<number>('n'));

async function seedLog(t: TestEnv, rows: { id: string; org?: string | null; to?: string; subject?: string; status?: string; error?: string | null; at?: number }[]) {
  const stmt = t.env.DB.prepare(
    `INSERT INTO email_log (id, org_id, to_addr, subject, template, status, error, created_at) VALUES (?1, ?2, ?3, ?4, 'test', ?5, ?6, ?7)`,
  );
  for (const r of rows) {
    await stmt.bind(r.id, r.org === undefined ? t.org.id : r.org, r.to ?? `${r.id}@example.com`, r.subject ?? `Subject ${r.id}`, r.status ?? 'sent', r.error ?? null, r.at ?? Date.now()).run();
  }
}

const idsIn = (html: string) => [...html.matchAll(/<dialog id="log-([^"]+)"/g)].map((m) => m[1]!);

describe('who may open Email', () => {
  it('sends a signed-out visitor to sign in', async () => {
    const { t } = await setup();
    const res = await get(t, null);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('/sign-in');
  });

  it('lets the instance owner and workspace admins in, and keeps members and viewers out', async () => {
    const { t, owner, admin, member, viewer } = await setup();
    expect((await get(t, owner)).status).toBe(200);
    expect((await get(t, admin)).status).toBe(200);
    expect((await get(t, member)).status).toBe(403);
    expect((await get(t, viewer)).status).toBe(403);
  });

  it('never lets a member or viewer post to any install-wide form', async () => {
    const { t, member, viewer } = await setup();
    for (const who of [member, viewer]) {
      expect((await post(t, who, '/app/email/sender', { fromName: 'X', fromAddress: 'x@example.com', replyTo: '' })).status).toBe(403);
      expect((await post(t, who, '/app/email/test', { to: 'x@example.com' })).status).toBe(403);
      expect((await post(t, who, '/app/email/blocked/allow', { address: 'x@example.com' })).status).toBe(403);
    }
  });
});

describe('workspace admins who do not run the install', () => {
  it('see a read-only status and cannot post any install-wide form, even by hand', async () => {
    const { t, admin } = await setup();
    await suppressAddress(t.env, 'bounced@example.com', 'hard bounce');
    const sender = await getSender(t.env);

    const page = await (await get(t, admin)).text();
    expect(page).toContain('Email is set up');
    expect(page).not.toContain('name="fromAddress"');
    expect(page).not.toContain('Blocked addresses');

    const saved = await post(t, admin, '/app/email/sender', { fromName: 'Mine', fromAddress: 'me@example.com', replyTo: '' });
    expect(saved.status).toBe(403);
    expect(await post(t, admin, '/app/email/test', { to: 'me@example.com' })).toHaveProperty('status', 403);
    expect((await post(t, admin, '/app/email/blocked/allow', { address: 'bounced@example.com' })).status).toBe(403);

    expect(await getSender(t.env)).toEqual(sender);
    expect(await isSuppressed(t.env, 'bounced@example.com')).toBe(true);
    expect(await devOutbox(t.env)).toHaveLength(0);
    expect(await auditCount(t, 'email.sender_changed')).toBe(0);
  });

  it('are told to ask the owner when email is off', async () => {
    const { t, admin } = await setup({ ENVIRONMENT: 'production' });
    expect(await (await get(t, admin)).text()).toContain('Email is not set up. Ask the person who runs this install.');
  });

  it('fall back to the setup tab if they open the blocked addresses tab', async () => {
    const { t, admin } = await setup();
    await suppressAddress(t.env, 'bounced@example.com', 'hard bounce');
    const page = await (await get(t, admin, '/app/email?tab=blocked')).text();
    expect(page).not.toContain('bounced@example.com');
    expect(page).toContain('Email is set up');
  });
});

describe('status', () => {
  it('says email is off and how to turn it on', async () => {
    const { t, owner } = await setup({ ENVIRONMENT: 'production' });
    const page = await (await get(t, owner)).text();
    expect(page).toContain('Email is not set up');
    expect(page).toContain('How to turn email on');
    expect(page).toContain('Email Sending');
    expect(page).toContain('send_email');
    expect(page).toMatch(/<button[^>]*disabled[^>]*>[\s\S]*?Send test email/);
  });

  it('marks the first steps done once the binding exists but no sender is chosen', async () => {
    const { t, owner } = await setup({ ENVIRONMENT: 'production', EMAIL: binding() as never });
    const page = await (await get(t, owner)).text();
    expect(page).toContain('Choose the address emails are sent from');
    expect(page).toContain('>Done<');
  });

  it('explains dev mode and links to the outbox', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner)).text();
    expect(page).toContain('Development mode');
    expect(page).toContain('/dev/outbox');
  });

  it('says email is on when a sender and binding exist', async () => {
    const { t, owner } = await setup({ ENVIRONMENT: 'production', EMAIL: binding() as never });
    await setSetting(t.env, INSTANCE, 'email.sender', { fromAddress: 'hello@mail.example.com', fromName: 'Acme' });
    const page = await (await get(t, owner)).text();
    expect(page).toContain('Email is on');
    expect(page).toContain('Acme &lt;hello@mail.example.com&gt;');
    expect(page).not.toContain('How to turn email on');
  });

  it('shows the limits read-only with the retention', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner)).text();
    expect(page).toContain('To one address, each hour');
    expect(page).toContain('30 days');
  });
});

describe('sender form', () => {
  it('saves the sender, audits it and redirects with a message', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/sender', { fromName: 'Acme', fromAddress: 'Hello@Mail.Example.com', replyTo: 'help@example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/email?tab=setup');
    expect(flashOf(res)).toMatchObject({ kind: 'ok', message: 'Sender saved.' });
    expect(await getSender(t.env)).toEqual({ fromName: 'Acme', fromAddress: 'hello@mail.example.com', replyTo: 'help@example.com' });
    expect(await auditCount(t, 'email.sender_changed')).toBe(1);
  });

  it('shows the saved sender in the form', async () => {
    const { t, owner } = await setup();
    await post(t, owner, '/app/email/sender', { fromName: 'Acme', fromAddress: 'hello@example.com', replyTo: '' });
    const page = await (await get(t, owner)).text();
    expect(page).toContain('value="Acme"');
    expect(page).toContain('value="hello@example.com"');
  });

  it('shows each problem next to its field and keeps what was typed', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/sender', { fromName: '  ', fromAddress: 'not-an-address', replyTo: 'also bad' });
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('Enter the name people will see.');
    expect(page).toContain('Enter a full address, like hello@example.com.');
    expect(page).toContain('Enter a full address, like help@example.com.');
    expect(page).toContain('value="not-an-address"');
    expect(page).toContain('value="also bad"');
    expect(await auditCount(t, 'email.sender_changed')).toBe(0);
    expect((await getSender(t.env)).fromAddress).toBe('');
  });

  it('rejects a name that could break the header', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/sender', { fromName: 'Evil <x@example.com>', fromAddress: 'a@example.com', replyTo: '' });
    expect(res.status).toBe(422);
    expect(await res.text()).toContain('Use letters, numbers and simple punctuation only.');
  });

  it('turns sending off when the address is cleared', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/sender', { fromName: 'Acme', fromAddress: '', replyTo: '' });
    expect(res.status).toBe(303);
    expect(flashOf(res)?.message).toContain('Sender cleared');
  });

  it('copes with the longest values and escapes markup in what it shows back', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/sender', { fromName: `<script>alert(1)</script>${'x'.repeat(300)}`, fromAddress: `${'a'.repeat(300)}@example.com`, replyTo: '' });
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).not.toContain('<script>alert(1)</script>');
    expect(page).toContain('&lt;script&gt;alert(1)');
  });
});

describe('send a test email', () => {
  it('defaults to the signed-in person and lands in the dev outbox', async () => {
    const { t, owner } = await setup();
    expect(await (await get(t, owner)).text()).toContain('value="owner@example.com"');
    const res = await post(t, owner, '/app/email/test', { to: 'owner@example.com' });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Kept in the dev outbox');
    expect(await devOutbox(t.env, { to: 'owner@example.com' })).toHaveLength(1);
    expect(await auditCount(t, 'email.test_sent')).toBe(1);
  });

  it('says it was sent when Cloudflare accepts it', async () => {
    const b = binding();
    const { t, owner } = await setup({ ENVIRONMENT: 'production', EMAIL: b as never });
    await setSetting(t.env, INSTANCE, 'email.sender', { fromAddress: 'hello@mail.example.com', fromName: 'Acme' });
    const res = await post(t, owner, '/app/email/test', { to: 'owner@example.com' });
    expect(await res.text()).toContain('Test email sent');
    expect(b.calls).toHaveLength(1);
  });

  it('says why a send failed', async () => {
    const { t, owner } = await setup({ ENVIRONMENT: 'production', EMAIL: binding(() => new CloudflareError('E_SENDER_NOT_VERIFIED')) as never });
    await setSetting(t.env, INSTANCE, 'email.sender', { fromAddress: 'hello@mail.example.com', fromName: 'Acme' });
    const page = await (await post(t, owner, '/app/email/test', { to: 'owner@example.com' })).text();
    expect(page).toContain('The test email failed');
    expect(page).toContain('isn’t set up in Cloudflare Email Sending');
  });

  it('shows a field error for an address that is not one', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/test', { to: 'nope' });
    expect(res.status).toBe(422);
    const page = await res.text();
    expect(page).toContain('Enter a full address, like you@example.com.');
    expect(page).toContain('value="nope"');
    expect(await devOutbox(t.env)).toHaveLength(0);
  });

  it('refuses when email is off', async () => {
    const { t, owner } = await setup({ ENVIRONMENT: 'production' });
    const res = await post(t, owner, '/app/email/test', { to: 'owner@example.com' });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('Set up email first');
  });

  it('stops after five tests an hour, once, by the service', async () => {
    const { t, owner } = await setup();
    for (let i = 0; i < 5; i++) expect((await post(t, owner, '/app/email/test', { to: 'owner@example.com' })).status).toBe(200);
    const res = await post(t, owner, '/app/email/test', { to: 'owner@example.com' });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('You sent a few test emails already');
  });
});

describe('delivery log', () => {
  it('shows an empty state when nothing was sent', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner, '/app/email?tab=log')).text();
    expect(page).toContain('No emails yet');
  });

  it('explains every status', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner, '/app/email?tab=log')).text();
    for (const label of ['Sent', 'Dev outbox', 'Not set up', 'Failed', 'Retrying', 'Blocked', 'Limit reached']) expect(page).toContain(label);
    expect(page).toContain('Entries are deleted after 30 days');
  });

  it('filters by status and searches by address or subject', async () => {
    const { t, owner } = await setup();
    await seedLog(t, [
      { id: 'a1', to: 'ann@example.com', subject: 'Welcome', status: 'sent' },
      { id: 'b2', to: 'bob@example.com', subject: 'Invoice ready', status: 'failed', error: 'The recipient’s mail server rejected the address.' },
      { id: 'c3', to: 'cy@example.com', subject: 'Welcome back', status: 'suppressed' },
    ]);
    expect(idsIn(await (await get(t, owner, '/app/email?tab=log&status=failed')).text())).toEqual(['b2']);
    expect(idsIn(await (await get(t, owner, '/app/email?tab=log&q=bob@')).text())).toEqual(['b2']);
    expect(idsIn(await (await get(t, owner, '/app/email?tab=log&q=welcome')).text()).sort()).toEqual(['a1', 'c3']);
    expect(idsIn(await (await get(t, owner, '/app/email?tab=log&q=welcome&status=sent')).text())).toEqual(['a1']);
    const none = await (await get(t, owner, '/app/email?tab=log&status=capped')).text();
    expect(none).toContain('No emails match');
    expect(none).toContain('Clear filters');
  });

  it('shows the error text in the detail view', async () => {
    const { t, owner } = await setup();
    await seedLog(t, [{ id: 'b2', status: 'failed', error: 'Cloudflare could not send it right now.' }]);
    const page = await (await get(t, owner, '/app/email?tab=log')).text();
    expect(page).toContain('What went wrong');
    expect(page).toContain('Cloudflare could not send it right now.');
  });

  it('pages through rows that share one timestamp without losing or repeating any', async () => {
    const { t, owner } = await setup();
    const at = Date.now() - 1000;
    await seedLog(t, Array.from({ length: 30 }, (_, i) => ({ id: `eml_${String(i).padStart(3, '0')}`, at })));
    const first = await (await get(t, owner, '/app/email?tab=log')).text();
    const firstIds = idsIn(first);
    expect(firstIds).toHaveLength(25);
    const next = /href="([^"]*before=[^"]+)" rel="next"/.exec(first)?.[1];
    expect(next).toBeTruthy();
    const second = await (await get(t, owner, next!.replace(/&amp;/g, '&'))).text();
    const secondIds = idsIn(second);
    expect(secondIds).toHaveLength(5);
    expect(new Set([...firstIds, ...secondIds]).size).toBe(30);
    expect(second).not.toContain('rel="next"');
    expect(second).toContain('Back to newest');
  });

  it('keeps the filters on the next page link', async () => {
    const { t, owner } = await setup();
    await seedLog(t, Array.from({ length: 27 }, (_, i) => ({ id: `eml_${String(i).padStart(3, '0')}`, status: 'failed', at: Date.now() - i })));
    const page = await (await get(t, owner, '/app/email?tab=log&status=failed')).text();
    expect(page).toMatch(/href="[^"]*status=failed[^"]*before=[^"]+" rel="next"/);
  });

  it('starts again at the newest email when the page marker is bad', async () => {
    const { t, owner } = await setup();
    await seedLog(t, [{ id: 'a1' }]);
    const res = await get(t, owner, '/app/email?tab=log&before=garbage');
    expect(res.status).toBe(200);
    expect(idsIn(await res.text())).toEqual(['a1']);
  });

  it('keeps one workspace out of another workspace log', async () => {
    const { t, owner, admin } = await setup();
    await seedLog(t, [
      { id: 'mine', org: t.org.id, to: 'mine@example.com' },
      { id: 'theirs', org: 'org_other', to: 'theirs@example.com' },
      { id: 'install', org: null, to: 'code@example.com', subject: 'Your sign-in code' },
    ]);
    const adminPage = await (await get(t, admin, '/app/email?tab=log')).text();
    expect(idsIn(adminPage)).toEqual(['mine']);
    expect(adminPage).not.toContain('theirs@example.com');
    expect(adminPage).not.toContain('code@example.com');
    expect(idsIn(await (await get(t, owner, '/app/email?tab=log')).text()).sort()).toEqual(['install', 'mine', 'theirs']);
  });

  it('escapes markup in the subject, address, error and blocked reason', async () => {
    const { t, owner } = await setup();
    await seedLog(t, [
      { id: 'x1', to: '"><img src=x onerror=alert(1)>@example.com', subject: '<script>alert(1)</script>', status: 'failed', error: '<b>bold</b> <script>x</script>' },
    ]);
    await suppressAddress(t.env, '<i>odd</i>@example.com', '<script>reason</script>');
    for (const path of ['/app/email?tab=log', '/app/email?tab=blocked']) {
      const page = await (await get(t, owner, path)).text();
      expect(page).not.toContain('<script>alert(1)</script>');
      expect(page).not.toContain('<script>x</script>');
      expect(page).not.toContain('<script>reason</script>');
      expect(page).not.toContain('<img src=x');
      expect(page).not.toContain('<i>odd</i>');
    }
    expect(await (await get(t, owner, '/app/email?tab=log')).text()).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('copes with a 300 character subject and address', async () => {
    const { t, owner } = await setup();
    await seedLog(t, [{ id: 'long', to: `${'a'.repeat(240)}@example.com`, subject: 'Ünïcödé 日本語 '.repeat(25) }]);
    expect((await get(t, owner, '/app/email?tab=log')).status).toBe(200);
  });
});

describe('blocked addresses', () => {
  it('shows an empty state', async () => {
    const { t, owner } = await setup();
    expect(await (await get(t, owner, '/app/email?tab=blocked')).text()).toContain('No blocked addresses');
  });

  it('lists the addresses with a confirm dialog that explains the risk', async () => {
    const { t, owner } = await setup();
    await suppressAddress(t.env, 'gone@example.com', 'hard bounce');
    const page = await (await get(t, owner, '/app/email?tab=blocked')).text();
    expect(page).toContain('gone@example.com');
    expect(page).toContain('hard bounce');
    expect(page).toContain('Allow email to this address again?');
    expect(page).toContain('sending reputation');
  });

  it('allows an address again, audits it and says so', async () => {
    const { t, owner } = await setup();
    await suppressAddress(t.env, 'gone@example.com', 'hard bounce');
    const res = await post(t, owner, '/app/email/blocked/allow', { address: 'Gone@Example.com' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/email?tab=blocked');
    expect(flashOf(res)).toMatchObject({ kind: 'ok' });
    expect(await isSuppressed(t.env, 'gone@example.com')).toBe(false);
    expect(await auditCount(t, 'email.suppression_removed')).toBe(1);
  });

  it('tells the person when the address was not blocked and writes no audit entry', async () => {
    const { t, owner } = await setup();
    const res = await post(t, owner, '/app/email/blocked/allow', { address: 'never@example.com' });
    expect(res.status).toBe(303);
    expect(flashOf(res)).toMatchObject({ kind: 'info' });
    expect(await auditCount(t, 'email.suppression_removed')).toBe(0);
  });
});

describe('templates', () => {
  it('previews the sign-in code email in English with sample data', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner, '/app/email?tab=templates')).text();
    expect(page).toContain('Plain-text version');
    expect(page).toContain('sign-in-code');
    expect(page).toContain('HTML source');
  });

  it('previews the same email in Spanish', async () => {
    const { t, owner } = await setup();
    const en = await (await get(t, owner, '/app/email?tab=templates&t=invite&lang=en')).text();
    const es = await (await get(t, owner, '/app/email?tab=templates&t=invite&lang=es')).text();
    expect(es).not.toEqual(en);
    expect(es).toMatch(/invit/i);
  });

  it('falls back to a safe preview for an unknown template or language', async () => {
    const { t, owner } = await setup();
    expect((await get(t, owner, '/app/email?tab=templates&t=nope&lang=xx')).status).toBe(200);
  });

  it('shows the email markup as text, never as markup', async () => {
    const { t, owner } = await setup();
    const page = await (await get(t, owner, '/app/email?tab=templates')).text();
    expect(page).not.toContain('<iframe');
    expect(page).toContain('&lt;');
  });

  it('is open to workspace admins too', async () => {
    const { t, admin } = await setup();
    expect((await get(t, admin, '/app/email?tab=templates')).status).toBe(200);
  });
});
