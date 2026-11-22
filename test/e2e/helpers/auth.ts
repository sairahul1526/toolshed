/**
 * Signed-in pages for end-to-end tests.
 *
 * The run starts on an empty database. Global setup claims the install as the owner once, names
 * the first workspace and saves that sign-in to `ownerState`. A test then starts signed in with
 *
 *   test.use({ storageState: ownerState });
 *
 * or asks for a page with `signedInPage(browser)`. `signedInPage(browser, { role: 'viewer' })`
 * gives a page signed in as an admin, member or viewer instead: the owner invites that person
 * and they accept through the real invite page. Other people sign in with a code read from the
 * dev outbox (`signInAs`). Everything here goes through the real pages; workspaces and invites
 * are made through `/dev/auth/*`, which runs the real service with the page's own session.
 */
import { resolve } from 'node:path';
import { expect, type APIRequestContext, type Browser, type Page } from '@playwright/test';

const port = Number(process.env.PORT ?? 8787);

export const baseURL = `http://127.0.0.1:${port}`;
/** The address that may claim the install. Set by the end-to-end server. */
export const OWNER_EMAIL = 'owner@example.com';
export const OWNER_NAME = 'Olive Owner';
export const FIRST_WORKSPACE = 'First Shed';
/** The owner's saved sign-in, written by global setup. One file per port, never in git. */
export const ownerState = resolve('.wrangler', 'e2e-auth', `owner-${port}.json`);

interface OutboxEmail {
  id: string;
  subject: string;
  template: string | null;
  text: string | null;
}

async function outbox(request: APIRequestContext, email: string): Promise<OutboxEmail[]> {
  const res = await request.get(`${baseURL}/dev/outbox`, { params: { to: email } });
  if (!res.ok()) throw new Error(`The dev outbox answered ${res.status()}`);
  return ((await res.json()) as { emails: OutboxEmail[] }).emails;
}

/**
 * The newest email to an address right now, as a mark. Take it before doing the thing that sends
 * an email and pass it to `readCode` as `after`, so an older email is never read by mistake.
 */
export async function outboxMark(request: APIRequestContext, email: string): Promise<string | null> {
  return (await outbox(request, email))[0]?.id ?? null;
}

/**
 * The 6-digit code in the newest email to an address. Emails are sent after the page has
 * answered, so this waits for one to arrive (and, with `after`, for one newer than that mark).
 */
export async function readCode(request: APIRequestContext, email: string, opts: { after?: string | null; timeoutMs?: number } = {}): Promise<string> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  for (;;) {
    const newest = (await outbox(request, email))[0];
    if (newest && (opts.after === undefined || newest.id !== opts.after)) {
      const code = newest.text?.match(/\b\d{6}\b/)?.[0];
      if (code) return code;
      throw new Error(`The newest email to ${email} ("${newest.subject}") has no code in it`);
    }
    if (Date.now() > deadline) throw new Error(`No new email reached ${email}. Only people with an account get one.`);
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** The path of the one-time sign-in link in the newest email to an address (newer than `after`). */
export async function readLink(request: APIRequestContext, email: string, opts: { after?: string | null; timeoutMs?: number } = {}): Promise<string> {
  await readCode(request, email, opts);
  const path = (await outbox(request, email))[0]?.text?.match(/\/sign-in\/link\/[A-Za-z0-9_-]+/)?.[0];
  if (!path) throw new Error(`The newest email to ${email} has no sign-in link in it`);
  return path;
}

/** Type a code into the six boxes. The form sends itself after the last digit. */
export async function enterCode(page: Page, code: string): Promise<void> {
  await page.getByLabel('Digit 1 of 6').click();
  await page.keyboard.type(code);
}

/**
 * Sign this page in as someone who already has an account, with an emailed code. Whoever was
 * signed in on the page before is signed out first. Ends on the page that follows sign-in.
 */
export async function signInAs(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  const mark = await outboxMark(page.request, email);
  await page.goto(`${baseURL}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await enterCode(page, await readCode(page.request, email, { after: mark }));
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'));
}

/** Fill in the "Name your workspace" step and continue. */
export async function nameWorkspace(page: Page, name = FIRST_WORKSPACE, yourName = OWNER_NAME): Promise<void> {
  await page.getByLabel('Workspace name').fill(name);
  await page.getByLabel('Your name').fill(yourName);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.waitForURL((url) => url.pathname !== '/setup/workspace');
  // With modules installed, setup offers a first thing to do. Tests start from the plain dashboard.
  if (new URL(page.url()).pathname === '/setup/first') await page.getByRole('link', { name: /^Skip/ }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/app'));
}

/**
 * Make sure the install has its owner and first workspace, and leave `page` signed in as the
 * owner on the dashboard. Safe to call again on an install that is already claimed.
 */
export async function ensureOwner(page: Page): Promise<void> {
  await page.goto(`${baseURL}/setup`);
  if (await page.getByRole('heading', { name: 'Claim this Toolshed' }).isVisible()) {
    const mark = await outboxMark(page.request, OWNER_EMAIL);
    await page.getByRole('button', { name: 'Send me a code' }).click();
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
    await enterCode(page, await readCode(page.request, OWNER_EMAIL, { after: mark }));
    await page.waitForURL('**/setup/workspace');
  } else {
    await signInAs(page, OWNER_EMAIL);
    // An owner who never named a workspace is sent back to that step.
    if (new URL(page.url()).pathname !== '/setup/workspace') await page.goto(`${baseURL}/setup`);
  }
  if (new URL(page.url()).pathname === '/setup/workspace') await nameWorkspace(page);
}

/** Call a `/dev/auth/*` door as the person signed in on `page`. Throws with the app's own message when refused. */
export async function authDoor<T>(page: Page, door: string, body: Record<string, unknown> = {}): Promise<T> {
  const res = await page.request.post(`${baseURL}/dev/auth/${door}`, { data: body, headers: { origin: baseURL, accept: 'application/json' } });
  const json = (await res.json().catch(() => ({}))) as { result?: T; message?: string; code?: string };
  if (!res.ok()) throw new Error(`${door} was refused (${res.status()} ${json.code ?? ''}): ${json.message ?? ''}`);
  return json.result as T;
}

export type MemberRole = 'admin' | 'member' | 'viewer';

/** The one person who holds each role in tests. The same person in every workspace. */
export const ROLE_PEOPLE: Record<MemberRole, { email: string; name: string }> = {
  admin: { email: 'admin@example.com', name: 'Adam Admin' },
  member: { email: 'member@example.com', name: 'Mel Member' },
  viewer: { email: 'viewer@example.com', name: 'Vic Viewer' },
};

export interface SignedInOptions {
  /**
   * A workspace other than the first one, by name. It is made if it is not there yet and becomes
   * the active one for this page only.
   */
  workspace?: string;
  /**
   * Sign in as the admin, member or viewer of the workspace (see `ROLE_PEOPLE`) instead of its
   * owner. The first time, the owner invites them and they accept; after that they just sign in.
   */
  role?: MemberRole;
}

async function openWorkspace(page: Page, name: string, create: boolean): Promise<void> {
  const known = await authDoor<{ id: string; name: string }[]>(page, 'list-workspaces');
  const found = known.find((w) => w.name === name);
  if (found) await authDoor(page, 'switch-workspace', { workspaceId: found.id });
  else if (create) await authDoor(page, 'create-workspace', { name });
  else throw new Error(`${name} is not a workspace this person is in`);
}

async function ownerPage(browser: Browser, workspace?: string): Promise<Page> {
  if (!workspace) return (await browser.newContext({ baseURL, storageState: ownerState })).newPage();
  // The active workspace belongs to the sign-in, so a second workspace gets a sign-in of its own
  // and tests that share the saved owner sign-in stay in the first one.
  const page = await (await browser.newContext({ baseURL })).newPage();
  await signInAs(page, OWNER_EMAIL);
  await openWorkspace(page, workspace, true);
  return page;
}

/** Accept an invite the way a person does: open its link, prove the inbox with a code, press Join. */
export async function acceptInvite(page: Page, link: string, email: string, name: string): Promise<void> {
  await page.goto(new URL(link).pathname);
  // The invite email is already in the outbox, so the code email is the one after it.
  const mark = await outboxMark(page.request, email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await enterCode(page, await readCode(page.request, email, { after: mark }));
  await page.waitForURL('**/invite/**');
  const ask = page.getByLabel('Your name');
  if (await ask.isVisible()) await ask.fill(name);
  await page.getByRole('button', { name: 'Join workspace' }).click();
  await page.waitForURL((url) => url.pathname.startsWith('/app'));
}

async function memberPage(browser: Browser, role: MemberRole, workspace?: string): Promise<Page> {
  const person = ROLE_PEOPLE[role];
  const owner = await ownerPage(browser, workspace);
  const page = await (await browser.newContext({ baseURL })).newPage();
  try {
    const members = await authDoor<{ userId: string; email: string; role: string }[]>(owner, 'list-members');
    const there = members.find((m) => m.email === person.email);
    if (!there) {
      const invite = await authDoor<{ link: string }>(owner, 'invite', { email: person.email, role });
      await acceptInvite(page, invite.link, person.email, person.name);
      return page;
    }
    // A test may have changed their role; put it back.
    if (there.role !== role) await authDoor(owner, 'change-role', { userId: there.userId, role });
  } finally {
    await owner.context().close();
  }
  await signInAs(page, person.email);
  await openWorkspace(page, workspace ?? FIRST_WORKSPACE, false);
  return page;
}

/**
 * A new page signed in as the owner (or, with `role`, as that workspace's admin, member or
 * viewer), in its own browser context, on the dashboard. Close the page's context when done
 * (`await page.context().close()`).
 */
export async function signedInPage(browser: Browser, opts: SignedInOptions = {}): Promise<Page> {
  const page = opts.role ? await memberPage(browser, opts.role, opts.workspace) : await ownerPage(browser, opts.workspace);
  await page.goto('/app');
  return page;
}
