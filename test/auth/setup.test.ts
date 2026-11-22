import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, CODE_MAX_ATTEMPTS } from '../../src/auth/config';
import { ownerEmail, TIMEZONE_KEY } from '../../src/auth/routes/setup';
import { sessionCookieName } from '../../src/auth/session';
import { devOutbox, sendEmail, suppressAddress } from '../../src/core/email';
import { defineModule } from '../../src/core/module';
import { moduleState, registerModules } from '../../src/core/registry';
import { getSetting } from '../../src/core/settings';
import type { Env } from '../../src/env';
import { createTestSession } from '../helpers/auth';
import { createTestEnv } from '../helpers/d1';
import { adopt, Browser, lastCode, lastEmail, ORIGIN, signInByCode, testApp } from './browser';

const OWNER = 'owner@example.com';
const SESSION = sessionCookieName(ORIGIN);
const app = testApp();

let env: Env;

const count = async (on: Env, sql: string, ...binds: unknown[]) => Number(await on.DB.prepare(sql).bind(...binds).first<number>('n'));
const users = (on: Env = env) => count(on, 'SELECT COUNT(*) AS n FROM "user"');
const codes = (on: Env = env) => count(on, 'SELECT COUNT(*) AS n FROM auth_codes');
const audits = (action: string) => count(env, 'SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1', action);

/** Go through step 1 the way the owner would. Ends on the answer to the code post. */
async function claim(b: Browser, on: Env = env): Promise<Response> {
  const start = await b.post('/setup');
  if (start.status !== 303) throw new Error(`Asking for a claim code answered ${start.status}`);
  return b.post('/setup/code', { code: await lastCode(on, OWNER) });
}

beforeEach(() => {
  env = createTestEnv().env;
});

afterEach(() => {
  registerModules([]);
  vi.restoreAllMocks();
});

describe('claiming a new install', () => {
  it('sends everyone to setup while there is no owner, and shows only a masked address', async () => {
    const b = new Browser(app, env);
    const signIn = await b.get('/sign-in');
    expect(signIn.status).toBe(302);
    expect(signIn.headers.get('location')).toBe('/setup');

    const page = await b.get('/setup');
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('Claim this Toolshed');
    expect(html).toContain('o•••@example.com');
    expect(html).not.toContain(OWNER);
  });

  it('lets the owner address claim with the emailed code, then name the workspace', async () => {
    const b = new Browser(app, env);
    const start = await b.post('/setup');
    expect(start.status).toBe(303);
    expect(start.headers.get('location')).toBe('/setup/code');
    expect((await lastEmail(env, OWNER))?.template).toBe('claim-code');
    const codePage = await (await b.get('/setup/code')).text();
    expect(codePage).toContain('Check your email');
    expect(codePage).not.toContain(OWNER);

    const done = await b.post('/setup/code', { code: await lastCode(env, OWNER) });
    expect(done.status).toBe(303);
    expect(done.headers.get('location')).toBe('/setup/workspace');
    expect(b.cookies.has(SESSION)).toBe(true);
    const owner = await env.DB.prepare('SELECT "id", "role", "emailVerified" FROM "user" WHERE "email" = ?1').bind(OWNER).first<{ id: string; role: string; emailVerified: number }>();
    expect(owner).toMatchObject({ role: 'admin', emailVerified: 1 });
    expect(await audits('install.claimed')).toBe(1);
    expect(await audits('user.signed_in')).toBe(1);

    expect((await b.get('/setup')).headers.get('location')).toBe('/setup/workspace');
    expect(await (await b.get('/setup/workspace')).text()).toContain('Name your workspace');

    const named = await b.post('/setup/workspace', { name: ' Northwind Studio ', slug: '', yourName: 'Ada Lovelace', timezone: 'Europe/London' });
    expect(named.status).toBe(303);
    // No module offers a first step here, so setup ends on the dashboard.
    expect(named.headers.get('location')).toBe('/app');

    const org = await env.DB.prepare('SELECT "id", "name", "slug" FROM "organization"').first<{ id: string; name: string; slug: string }>();
    expect(org).toMatchObject({ name: 'Northwind Studio', slug: 'northwind-studio' });
    expect(await env.DB.prepare('SELECT "role" FROM "member" WHERE "organizationId" = ?1 AND "userId" = ?2').bind(org!.id, owner!.id).first<string>('role')).toBe('owner');
    expect(await env.DB.prepare('SELECT "activeOrganizationId" AS a FROM "session" WHERE "userId" = ?1').bind(owner!.id).first<string>('a')).toBe(org!.id);
    expect(await env.DB.prepare('SELECT "name" FROM "user" WHERE "id" = ?1').bind(owner!.id).first<string>('name')).toBe('Ada Lovelace');
    expect(await getSetting(env, org!.id, TIMEZONE_KEY, '')).toBe('Europe/London');
    expect(await audits('workspace.created')).toBe(1);

    const after = await b.get('/setup');
    expect(await after.text()).toContain('already has an owner');
    expect((await b.get('/setup/workspace')).headers.get('location')).toBe('/app');
  });

  it('never takes an address from the person asking', async () => {
    const b = new Browser(app, env);
    const start = await b.post('/setup', { email: 'mallory@example.com', OWNER_EMAIL: 'mallory@example.com' });
    expect(start.status).toBe(303);
    expect(await devOutbox(env, { to: 'mallory@example.com' })).toHaveLength(0);
    expect(await devOutbox(env, { to: OWNER })).toHaveLength(1);
    expect(await env.DB.prepare('SELECT email FROM auth_codes').first<string>('email')).toBe(OWNER);
  });

  it('counts wrong codes, then pauses, and makes no account', async () => {
    const b = new Browser(app, env);
    await b.post('/setup');
    const right = await lastCode(env, OWNER);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let left = CODE_MAX_ATTEMPTS - 1; left >= 1; left--) {
      const res = await b.post('/setup/code', { code: wrong });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(`${left} ${left === 1 ? 'try' : 'tries'} left`);
    }
    const paused = await b.post('/setup/code', { code: wrong });
    expect(paused.status).toBe(429);
    expect(await paused.text()).toContain('Too many tries');
    // Even the right code is refused while the pause lasts.
    expect((await b.post('/setup/code', { code: right })).status).toBe(429);
    expect(await users()).toBe(0);
    expect(b.cookies.has(SESSION)).toBe(false);
  });

  it('refuses a code once it has been used, and one from another browser', async () => {
    const a = new Browser(app, env);
    const other = new Browser(app, env, '198.51.100.21');
    await a.post('/setup');
    const code = await lastCode(env, OWNER);
    // The other browser never asked for a code, so it has nothing to check one against.
    const stray = await other.post('/setup/code', { code });
    expect(stray.status).toBe(303);
    expect(stray.headers.get('location')).toBe('/setup');
    expect(await users()).toBe(0);

    const replay = a.clone();
    expect((await a.post('/setup/code', { code })).headers.get('location')).toBe('/setup/workspace');
    const second = await replay.post('/setup/code', { code });
    expect(second.headers.get('location')).toBe('/setup');
    expect(replay.cookies.has(SESSION)).toBe(false);
    expect(await count(env, 'SELECT COUNT(*) AS n FROM "session"')).toBe(1);
  });

  it('refuses a code sent to an address that is no longer the owner address', async () => {
    const b = new Browser(app, env);
    await b.post('/setup');
    const code = await lastCode(env, OWNER);
    const moved = new Browser(app, { ...env, OWNER_EMAIL: 'new-owner@example.com' });
    for (const [name, value] of b.cookies) moved.cookies.set(name, value);
    const res = await moved.post('/setup/code', { code });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
    expect(await users()).toBe(0);
  });

  it('hands an install that lost its owner back to the owner address, suspended or not', async () => {
    const before = await createTestSession(env, { email: OWNER, role: 'member' });
    await env.DB.prepare(`UPDATE "user" SET "banned" = 1, "banReason" = 'test' WHERE "id" = ?1`).bind(before.user.id).run();
    const b = new Browser(app, env);
    expect(await (await b.get('/setup')).text()).toContain('Claim this Toolshed');

    const done = await claim(b);
    expect(done.headers.get('location')).toBe('/setup/workspace');
    expect(b.cookies.has(SESSION)).toBe(true);
    const row = await env.DB.prepare('SELECT "role", "banned" FROM "user" WHERE "id" = ?1').bind(before.user.id).first<{ role: string; banned: number }>();
    expect(row).toEqual({ role: 'admin', banned: 0 });
    expect(await users()).toBe(1);
    // They already have a workspace, so there is nothing left to set up.
    expect((await b.get('/setup/workspace')).headers.get('location')).toBe('/app');
  });

  it('refuses a form post from another site', async () => {
    const b = new Browser(app, env);
    const res = await b.post('/setup', {}, { origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(await codes()).toBe(0);
  });

  it('stops sending claim codes after the limit, whoever asks', async () => {
    for (let i = 0; i < LIMITS.claim.limit; i++) {
      expect((await new Browser(app, env, `198.51.100.${30 + i}`).post('/setup')).status).toBe(303);
    }
    const over = await new Browser(app, env, '198.51.100.99').post('/setup');
    expect(over.status).toBe(429);
    expect(await over.text()).toContain('Too many tries');
    expect(await codes()).toBe(LIMITS.claim.limit);
  });
});

describe('an install with no usable owner address', () => {
  it.each([undefined, '', 'not-an-address', 'a@b'])('cannot be claimed when OWNER_EMAIL is %j, in any environment', async (value) => {
    for (const mode of ['test', 'dev', 'production']) {
      const t = createTestEnv({ ENVIRONMENT: mode, OWNER_EMAIL: value });
      expect(ownerEmail(t.env)).toBeNull();
      const b = new Browser(app, t.env);
      const page = await b.get('/setup');
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('Set an owner email first');

      const post = await b.post('/setup', { email: 'mallory@example.com' });
      expect(post.status).toBe(303);
      expect(post.headers.get('location')).toBe('/setup');
      expect((await b.post('/setup/code', { code: '123456' })).headers.get('location')).toBe('/setup');
      expect(await codes(t.env)).toBe(0);
      expect(await users(t.env)).toBe(0);
    }
  });

  it('reads the address trimmed and in lower case', () => {
    expect(ownerEmail(createTestEnv({ OWNER_EMAIL: ' Owner@Example.com ' }).env)).toBe(OWNER);
  });
});

describe('an install that already has an owner', () => {
  it('shows "already claimed" and sends no more codes', async () => {
    await createTestSession(env, { email: OWNER, instanceOwner: true });
    const b = new Browser(app, env);
    const page = await b.get('/setup');
    const html = await page.text();
    expect(html).toContain('This Toolshed already has an owner');
    expect(html).toContain('href="/sign-in"');

    const post = await b.post('/setup');
    expect(post.status).toBe(303);
    expect(post.headers.get('location')).toBe('/setup');
    expect(await codes()).toBe(0);
    expect(await devOutbox(env, { to: OWNER })).toHaveLength(0);
    // The later steps have nothing to show a visitor: each one sends them away.
    expect((await b.get('/setup/code')).headers.get('location')).toBe('/setup');
    expect((await b.get('/setup/workspace')).headers.get('location')).toBe('/setup');
    expect((await b.get('/setup/first')).headers.get('location')).toBe('/app');
  });

  it('does not let a code asked for earlier claim it again', async () => {
    const first = new Browser(app, env);
    const late = new Browser(app, env, '198.51.100.21');
    await late.post('/setup');
    const lateCode = await lastCode(env, OWNER);
    await first.post('/setup');
    // Two emails can share a millisecond, so find the newer code by what it is not.
    const sent = (await devOutbox(env, { to: OWNER })).map((mail) => mail.text?.match(/\b\d{6}\b/)?.[0]);
    const firstCode = sent.find((code) => code !== lateCode) ?? lateCode;
    expect((await first.post('/setup/code', { code: firstCode })).headers.get('location')).toBe('/setup/workspace');

    const res = await late.post('/setup/code', { code: lateCode });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/setup');
    expect(late.cookies.has(SESSION)).toBe(false);
    expect(await users()).toBe(1);
  });

  it('keeps people who are not the owner out of the later steps', async () => {
    await createTestSession(env, { email: OWNER, instanceOwner: true });
    const member = adopt(new Browser(app, env), (await createTestSession(env, { email: 'sam@example.com', role: 'member' })).cookie);
    expect((await member.get('/setup/workspace')).headers.get('location')).toBe('/app');
    const post = await member.post('/setup/workspace', { name: 'Mine', slug: '', yourName: 'Sam', timezone: 'UTC' });
    expect(post.headers.get('location')).toBe('/app');
    expect(await count(env, 'SELECT COUNT(*) AS n FROM "organization"')).toBe(1);
    expect((await member.get('/setup/first')).headers.get('location')).toBe('/app');
  });
});

describe('the claim code when the install cannot send email', () => {
  const binding = (behave: () => unknown = () => ({ messageId: 'cf_1' })) => ({
    async send() {
      const out = behave();
      if (out instanceof Error) throw out;
      return out;
    },
  });
  const live = (vars: Partial<Env> = {}) => createTestEnv({ ENVIRONMENT: 'production', EMAIL: binding() as never, ...vars }).env;
  const failure = (code: string) => Object.assign(new Error(code), { code });

  it('writes the code to the log, alone on its line, and says where to find it', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const on = live();
    const b = new Browser(app, on);
    expect((await b.post('/setup')).headers.get('location')).toBe('/setup/code');

    expect(log).toHaveBeenCalledTimes(1);
    const line = String(log.mock.calls[0]?.[0]);
    expect(log.mock.calls[0]).toHaveLength(1);
    expect(line).toMatch(/^Toolshed claim code: \d{6}$/);
    const html = await (await b.get('/setup/code')).text();
    expect(html).toContain('Get the code from your logs');
    expect(html).toContain('wrangler tail');
    expect(html).not.toContain(line.slice(-6));

    const done = await b.post('/setup/code', { code: line.slice(-6) });
    expect(done.headers.get('location')).toBe('/setup/workspace');
    expect(await users(on)).toBe(1);
  });

  it('logs nothing when the email went out, was kept for a retry, or was saved in dev', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const sent = live({ EMAIL_FROM: 'hello@mail.example.com' });
    const retrying = live({ EMAIL_FROM: 'hello@mail.example.com', EMAIL: binding(() => failure('E_INTERNAL_SERVER_ERROR')) as never });
    for (const on of [sent, retrying, env, createTestEnv({ ENVIRONMENT: 'dev' }).env]) {
      const b = new Browser(app, on);
      expect((await b.post('/setup')).headers.get('location')).toBe('/setup/code');
      expect(await (await b.get('/setup/code')).text()).toContain('Check your email');
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('logs nothing and says so when the email failed for another reason', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const failed = live({ EMAIL_FROM: 'hello@mail.example.com', EMAIL: binding(() => failure('E_VALIDATION_ERROR')) as never });
    const suppressed = live({ EMAIL_FROM: 'hello@mail.example.com' });
    await suppressAddress(suppressed, OWNER, 'bounced');
    for (const on of [failed, suppressed]) {
      const res = await new Browser(app, on).post('/setup');
      expect(res.status).toBe(502);
      expect(await res.text()).toContain('We couldn’t send the email');
    }
    expect(log).not.toHaveBeenCalled();
  });

  it('still sends the claim code when other emails used up the hourly room for the owner address', async () => {
    const calls: unknown[] = [];
    const on = live({ EMAIL_FROM: 'hello@mail.example.com', EMAIL: binding(() => (calls.push(1), { messageId: 'cf_1' })) as never });
    const other = { to: OWNER, subject: 'Hello', html: '<p>hello</p>', text: 'hello', template: 'test' };
    let last = '';
    for (let i = 0; i < 12; i++) last = (await sendEmail(on, other)).status;
    expect(last).toBe('capped');
    calls.length = 0;

    const res = await new Browser(app, on).post('/setup');
    expect(res.headers.get('location')).toBe('/setup/code');
    expect(calls).toHaveLength(1);
  });

  it('logs nothing at all once the install is claimed, and never a sign-in code', async () => {
    const on = live();
    const quiet = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const owner = new Browser(app, on);
    await owner.post('/setup');
    const code = String(quiet.mock.calls[0]?.[0]).slice(-6);
    await owner.post('/setup/code', { code });
    quiet.mockClear();

    const stranger = new Browser(app, on, '198.51.100.21');
    expect((await stranger.post('/setup')).headers.get('location')).toBe('/setup');
    expect((await stranger.post('/sign-in', { email: OWNER, intent: 'code' })).status).toBe(303);
    expect(quiet).not.toHaveBeenCalled();
    expect(await codes(on)).toBe(2);
  });
});

describe('naming the first workspace', () => {
  let b: Browser;

  beforeEach(async () => {
    b = new Browser(app, env);
    await claim(b);
  });

  it('asks again with a message under each field that is wrong', async () => {
    const res = await b.post('/setup/workspace', { name: '  ', slug: 'Bad Slug!', yourName: '', timezone: 'Mars/Olympus' });
    const html = await res.text();
    expect(res.status).toBe(422);
    expect(html).toContain('Enter a name for the workspace.');
    expect(html).toContain('Use 1 to 40 letters, numbers and dashes.');
    expect(html).toContain('Enter your name.');
    expect(html).toContain('Pick a time zone from the list.');
    expect(await count(env, 'SELECT COUNT(*) AS n FROM "organization"')).toBe(0);
  });

  it('keeps a short name that was typed, and says when it is taken', async () => {
    await env.DB.prepare('INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES (?1, ?2, ?3, ?4)').bind('org_other', 'Other', 'acme', new Date().toISOString()).run();
    const taken = await b.post('/setup/workspace', { name: 'Acme', slug: 'acme', yourName: 'Ada', timezone: 'UTC' });
    expect(taken.status).toBe(409);
    expect(await taken.text()).toContain('That short name is taken');

    // With no short name typed, one that is free is made from the name.
    const made = await b.post('/setup/workspace', { name: 'Acme', slug: '', yourName: 'Ada', timezone: 'UTC' });
    expect(made.status).toBe(303);
    expect(await env.DB.prepare('SELECT "slug" FROM "organization" WHERE "name" = ?1').bind('Acme').first<string>('slug')).toBe('acme-2');
  });

  it('does not make a second workspace when the form is sent twice', async () => {
    const form = { name: 'Acme', slug: '', yourName: 'Ada', timezone: 'UTC' };
    expect((await b.post('/setup/workspace', form)).headers.get('location')).toBe('/app');
    expect((await b.post('/setup/workspace', form)).headers.get('location')).toBe('/app');
    expect(await count(env, 'SELECT COUNT(*) AS n FROM "organization"')).toBe(1);
  });

  it('sends a signed-out visitor back to the start', async () => {
    const res = await new Browser(app, env).get('/setup/workspace');
    expect(res.headers.get('location')).toBe('/setup');
  });
});

describe('what to do first', () => {
  const filled: string[] = [];
  const links = () =>
    defineModule({
      id: 'links', name: 'Links', description: 'Short links', icon: 'link', category: 'growth', version: '0.1.0',
      onboarding: { title: 'Make a short link', body: 'Branded links on your own domain.' },
      sampleData: async (ctx) => void filled.push(ctx.org.id),
    });
  const forms = () =>
    defineModule({
      id: 'forms', name: 'Forms', description: 'Forms', icon: 'form', category: 'growth', version: '0.1.0',
      onboarding: { title: 'Build a form', body: 'Sign-ups and feedback.', href: '/app/forms/new' },
    });
  const quiet = () => defineModule({ id: 'quiet', name: 'Quiet', description: 'No card', icon: 'bell', category: 'growth', version: '0.1.0' });

  let b: Browser;
  let orgId: string;

  async function setUp(modules = [links(), forms(), quiet()]): Promise<void> {
    registerModules(modules);
    b = new Browser(testApp(), env);
    await claim(b);
    const named = await b.post('/setup/workspace', { name: 'Acme', slug: '', yourName: 'Ada', timezone: 'UTC' });
    expect(named.headers.get('location')).toBe('/setup/first');
    orgId = (await env.DB.prepare('SELECT "id" FROM "organization"').first<string>('id'))!;
  }

  beforeEach(() => {
    filled.length = 0;
  });

  it('shows a card for each module that offers one', async () => {
    await setUp();
    const html = await (await b.get('/setup/first')).text();
    expect(html).toContain('What do you want to do first?');
    expect(html).toContain('Make a short link');
    expect(html).toContain('Build a form');
    expect(html).not.toContain('No card');
    expect(html).toContain('Show sample data');
  });

  it('turns the picked module on, fills it with sample data when asked, and opens it', async () => {
    await setUp();
    const res = await b.post('/setup/first', { module: 'links', sample: 'yes' });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('/app/links');
    expect(await moduleState(env, orgId, 'links')).toMatchObject({ enabled: true, sample: true });
    expect(await moduleState(env, orgId, 'forms')).toMatchObject({ enabled: false });
    expect(filled).toEqual([orgId]);
    expect(await audits('module.enabled')).toBe(1);
    // The step is offered once.
    expect((await b.get('/setup/first')).headers.get('location')).toBe('/app');
    expect((await b.post('/setup/first', { module: 'forms' })).headers.get('location')).toBe('/app');
    expect(await moduleState(env, orgId, 'forms')).toMatchObject({ enabled: false });
  });

  it('leaves sample data out when the box is not ticked or the module has none', async () => {
    await setUp();
    const res = await b.post('/setup/first', { module: 'forms', sample: 'yes' });
    expect(res.headers.get('location')).toBe('/app/forms/new');
    expect(await moduleState(env, orgId, 'forms')).toMatchObject({ enabled: true, sample: false });

    env = createTestEnv().env;
    await setUp();
    await b.post('/setup/first', { module: 'links' });
    expect(await moduleState(env, orgId, 'links')).toMatchObject({ enabled: true, sample: false });
    expect(filled).toEqual([]);
  });

  it('still lets the owner in when a module fails to make its sample data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const broken = defineModule({
      id: 'links', name: 'Links', description: 'Short links', icon: 'link', category: 'growth', version: '0.1.0',
      onboarding: { title: 'Make a short link', body: 'Branded links.', href: 'https://evil.example/' },
      sampleData: async () => {
        throw new Error('boom');
      },
    });
    await setUp([broken]);
    const res = await b.post('/setup/first', { module: 'links', sample: 'yes' });
    // A card can only ever lead somewhere on this site.
    expect(res.headers.get('location')).toBe('/app');
    expect(await moduleState(env, orgId, 'links')).toMatchObject({ enabled: true, sample: false });
  });

  it('asks again when nothing, or something that is not a card, was picked', async () => {
    await setUp();
    for (const form of [{}, { module: 'quiet' }, { module: 'nope' }] as Record<string, string>[]) {
      const res = await b.post('/setup/first', form);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain('Pick one, or skip this step.');
    }
    expect(await moduleState(env, orgId, 'quiet')).toMatchObject({ enabled: false });
  });

  it('is closed to someone who did not just set the install up', async () => {
    await setUp();
    const again = new Browser(testApp(), env);
    await signInByCode(again, env, OWNER);
    expect((await again.get('/setup/first')).headers.get('location')).toBe('/app');
    expect((await again.post('/setup/first', { module: 'links' })).headers.get('location')).toBe('/app');
    expect(await moduleState(env, orgId, 'links')).toMatchObject({ enabled: false });
  });
});
