import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import {
  acceptInvite,
  authDoor,
  enterCode,
  FIRST_WORKSPACE,
  newPerson,
  outboxMark,
  OWNER_EMAIL,
  ownerState,
  readCode,
  readLink,
  ROLE_PEOPLE,
  RUN,
  setupLook,
  signedInPage,
  signInAs,
} from './helpers/auth';
import { look } from './helpers/look';
import { addPasskey, addPasskeyDevice, passkeyURL } from './helpers/passkey';
import { secretFromUri, totp } from './helpers/totp';

const PASSWORD = 'plum-harbor-lantern-42';
// As long as an address may be, with nowhere to break: the worst case for a narrow screen.
const LONG_EMAIL = `a-very-long-address-that-keeps-going-and-going-${RUN}@${'department-of-long-names.'.repeat(6)}example.com`;

/** Ask for a sign-in code as `email` and type the one that arrives. */
async function signInWithCode(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  const mark = await outboxMark(page.request, email);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await enterCode(page, await readCode(page.request, email, { after: mark }));
}

/** From the first sign-in page to the password page, with the password typed and sent. */
async function signInWithPassword(page: Page, email: string, password: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Use a password instead' }).click();
  await expect(page.getByRole('heading', { name: 'Enter your password' })).toBeVisible();
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test.describe('an install that global setup claimed', () => {
  test('shows "already claimed" to a visitor', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'This Toolshed already has an owner' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    await look(page, 'setup-claimed');
  });

  test('had first-run pages that fit a phone and logged no errors', () => {
    // Global setup looks at them while it claims, the only time they can be seen, and leaves a note.
    expect(JSON.parse(readFileSync(setupLook, 'utf8'))).toEqual([]);
  });

  test('sends a signed-out visitor from the dashboard to sign-in', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/sign-in/);
  });
});

test.describe('the owner', () => {
  test.use({ storageState: ownerState });

  test('starts signed in from the saved state', async ({ page }) => {
    await page.goto('/app');
    await expect(page).toHaveURL(/\/app/);
    await expect(page.getByText(FIRST_WORKSPACE).first()).toBeVisible();
  });
});

test('signs out, then signs in again with an emailed code', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await signInAs(page, OWNER_EMAIL);
  await expect(page).toHaveURL(/\/app/);
  await page.context().close();
});

test('signs in with the link in the email, after pressing the button on its page', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  const mark = await outboxMark(page.request, OWNER_EMAIL);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(OWNER_EMAIL);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();

  await page.goto(await readLink(page.request, OWNER_EMAIL, { after: mark }));
  await expect(page.getByRole('heading', { name: 'Finish signing in' })).toBeVisible();
  await look(page, 'sign-in-link');
  // Opening the link is not enough.
  expect((await page.request.get('/app', { maxRedirects: 0 })).status()).toBe(302);
  await page.getByRole('button', { name: 'Finish signing in' }).click();
  await expect(page).toHaveURL(/\/app/);

  // A link works once, and a made-up one never did.
  const spent = await (await browser.newContext()).newPage();
  await spent.goto('/sign-in/link/not-a-real-link');
  await expect(spent.getByRole('heading', { name: 'This link no longer works' })).toBeVisible();
  await look(spent, 'sign-in-link-dead');
  await spent.context().close();
  await page.context().close();
});

test('gives a stranger the same pages as a member, at any width', async ({ browser }) => {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/sign-in');
  await look(page, 'sign-in');
  await page.getByLabel('Email').fill('not an address');
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByText('Enter an email address like name@example.com.')).toBeVisible();
  await look(page, 'sign-in-bad-email');

  // Nobody has this address. The page says the same thing it says to a member, and no email goes out.
  await page.getByLabel('Email').fill(LONG_EMAIL);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await look(page, 'sign-in-code');
  await enterCode(page, '000000');
  await expect(page.getByText(/That code isn’t right\. 4 tries left\./)).toBeVisible();
  await look(page, 'sign-in-code-wrong');
  expect(await outboxMark(page.request, LONG_EMAIL)).toBeNull();

  await signInWithPassword(page, LONG_EMAIL, 'whatever-they-guess');
  await expect(page.getByText('That email or password isn’t right.')).toBeVisible();
  await look(page, 'sign-in-password-wrong');

  await page.goto('/sign-up');
  await expect(page.getByRole('heading', { name: 'Accounts are by invite' })).toBeVisible();
  await look(page, 'sign-up');
  await page.context().close();
});

test.describe('a password and two-step sign-in', () => {
  test('a new member sets a password, turns on two-step, and signs in with each', async ({ browser }) => {
    const { page, email } = await newPerson(browser, 'two-step', 'Tess Twostep');
    await authDoor(page, 'set-password', { password: PASSWORD });
    expect(await authDoor<{ hasPassword: boolean; twoStep: boolean }>(page, 'account')).toMatchObject({ hasPassword: true, twoStep: false });

    await signInWithPassword(page, email, 'not-the-password');
    await expect(page.getByText('That email or password isn’t right.')).toBeVisible();
    await signInWithPassword(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/app/);

    // An account with a password must give it again to turn two-step on.
    await expect(authDoor(page, 'start-two-step')).rejects.toThrow(/start-two-step was refused/);
    const setup = await authDoor<{ uri: string; recoveryCodes: string[] }>(page, 'start-two-step', { password: PASSWORD });
    const secret = secretFromUri(setup.uri);
    expect(setup.recoveryCodes.length).toBeGreaterThan(5);
    // Nothing changes until the authenticator app has proved itself.
    expect(await authDoor<{ twoStep: boolean }>(page, 'account')).toMatchObject({ twoStep: false });
    await authDoor(page, 'confirm-two-step', { code: totp(secret) });
    expect(await authDoor<{ twoStep: boolean }>(page, 'account')).toMatchObject({ twoStep: true });

    // The password alone no longer signs in.
    await signInWithPassword(page, email, PASSWORD);
    await expect(page.getByRole('heading', { name: 'Two-step check' })).toBeVisible();
    await look(page, 'sign-in-two-step');
    expect((await page.request.get('/app', { maxRedirects: 0 })).status()).toBe(302);
    await enterCode(page, totp(secret));
    await expect(page).toHaveURL(/\/app/);

    // Neither does an emailed code.
    await signInWithCode(page, email);
    await expect(page.getByRole('heading', { name: 'Two-step check' })).toBeVisible();

    // A recovery code stands in for the app, once.
    await page.getByRole('link', { name: 'Use a recovery code' }).click();
    await expect(page.getByRole('heading', { name: 'Use a recovery code' })).toBeVisible();
    await look(page, 'sign-in-recovery');
    await page.getByLabel('Recovery code').fill(setup.recoveryCodes[0] ?? '');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page).toHaveURL(/\/app/);

    await signInWithPassword(page, email, PASSWORD);
    await page.getByRole('link', { name: 'Use a recovery code' }).click();
    await page.getByLabel('Recovery code').fill(setup.recoveryCodes[0] ?? '');
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByText('That recovery code isn’t right, or it was already used.')).toBeVisible();
    expect((await page.request.get('/app', { maxRedirects: 0 })).status()).toBe(302);
    await page.context().close();
  });
});

test('pauses sign-in after too many wrong codes, and the emailed link still works', async ({ browser }) => {
  const { page, email } = await newPerson(browser, 'paused', 'Pat Paused');
  await page.context().clearCookies();
  const mark = await outboxMark(page.request, email);
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: 'Email me a code' }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  const real = await readCode(page.request, email, { after: mark });
  const wrong = real === '000000' ? '111111' : '000000';

  for (const left of ['4 tries left', '3 tries left', '2 tries left', '1 try left']) {
    await enterCode(page, wrong);
    await expect(page.getByText(`That code isn’t right. ${left}.`)).toBeVisible();
  }
  await enterCode(page, wrong);
  await expect(page.getByRole('heading', { name: 'Too many tries' })).toBeVisible();
  await expect(page.getByText(/Try again in \d+ (minutes|minute|seconds)\./)).toBeVisible();
  await expect(page.getByText('TS-AUTH-429')).toBeVisible();
  await look(page, 'sign-in-limited');

  // A new code can be asked for, but while the pause lasts even the right one is turned away.
  await signInWithCode(page, email);
  await expect(page.getByRole('heading', { name: 'Too many tries' })).toBeVisible();
  expect((await page.request.get('/app', { maxRedirects: 0 })).status()).toBe(302);

  // The link in the email was never guessable, so it still signs them in.
  await page.goto(await readLink(page.request, email, { after: mark }));
  await page.getByRole('button', { name: 'Finish signing in' }).click();
  await expect(page).toHaveURL(/\/app/);
  await page.context().close();
});

test('adds a passkey and signs in with it', async ({ browser }) => {
  const { page: first, email } = await newPerson(browser, 'passkey', 'Pia Passkey');
  await first.context().close();

  const page = await (await browser.newContext({ baseURL: passkeyURL })).newPage();
  await addPasskeyDevice(page);
  await signInAs(page, email, passkeyURL);
  await expect(page).toHaveURL(/\/app/);
  await addPasskey(page, 'Test laptop');
  expect(await authDoor<{ name: string }[]>(page, 'list-passkeys', {}, passkeyURL)).toMatchObject([{ name: 'Test laptop' }]);

  await page.context().clearCookies();
  await page.goto('/sign-in');
  await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
  await expect(page).toHaveURL(/\/app/);
  expect((await authDoor<{ email: string }>(page, 'account', {}, passkeyURL)).email).toBe(email);
  await look(page, 'app-after-passkey');
  await page.context().close();
});

test('a second workspace is active for its own page only', async ({ browser }) => {
  const second = await signedInPage(browser, { workspace: 'Second Shed' });
  await expect(second.getByText('Second Shed').first()).toBeVisible();
  const first = await signedInPage(browser);
  await expect(first.getByText(FIRST_WORKSPACE).first()).toBeVisible();
  await second.context().close();
  await first.context().close();
});

test.describe('invites', () => {
  test('an invited person joins from their own browser', async ({ browser }) => {
    const owner = await signedInPage(browser);
    const invite = await authDoor<{ link: string; role: string }>(owner, 'invite', { email: 'guest@example.com', role: 'member' });
    const path = new URL(invite.link).pathname;

    // The owner is signed in as someone else, and is told so instead of being let in.
    await owner.goto(path);
    await expect(owner.getByRole('heading', { name: 'This invite is for a different email' })).toBeVisible();
    await look(owner, 'invite-other-account');

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(path);
    await expect(guest.getByRole('heading', { name: `Join ${FIRST_WORKSPACE}` })).toBeVisible();
    await expect(guest.getByText('guest@example.com').first()).toBeVisible();
    await look(guest, 'invite-join');
    await acceptInvite(guest, invite.link, 'guest@example.com', 'Gus Guest');
    await expect(guest.getByText(FIRST_WORKSPACE).first()).toBeVisible();

    const members = await authDoor<{ email: string; name: string; role: string }[]>(owner, 'list-members');
    expect(members.find((m) => m.email === 'guest@example.com')).toMatchObject({ name: 'Gus Guest', role: 'member' });

    // The link is spent: its owner lands in the app, a stranger sees it no longer works.
    await guest.goto(path);
    await expect(guest).toHaveURL(/\/app/);
    const stranger = await (await browser.newContext()).newPage();
    await stranger.goto(path);
    await expect(stranger.getByRole('heading', { name: 'This invite no longer works' })).toBeVisible();
    await look(stranger, 'invite-dead');

    for (const page of [owner, guest, stranger]) await page.context().close();
  });

  test('a viewer is kept out of what only admins may do', async ({ browser }) => {
    const viewer = await signedInPage(browser, { role: 'viewer' });
    await expect(viewer).toHaveURL(/\/app/);
    expect((await viewer.request.get('/api/v1/audit')).status()).toBe(403);
    await expect(authDoor(viewer, 'invite', { email: 'friend@example.com', role: 'viewer' })).rejects.toThrow(/auth\.role_needed/);
    await expect(authDoor(viewer, 'list-invites')).rejects.toThrow(/auth\.role_needed/);

    const admin = await signedInPage(browser, { role: 'admin' });
    expect((await admin.request.get('/api/v1/audit')).status()).toBe(200);
    // An admin manages people, but not owners.
    const members = await authDoor<{ userId: string; email: string; role: string }[]>(admin, 'list-members');
    const owner = members.find((m) => m.email === OWNER_EMAIL);
    await expect(authDoor(admin, 'change-role', { userId: owner?.userId, role: 'member' })).rejects.toThrow(/auth\.role_over_owner/);

    // Asking for the same role again signs the same person in, without a second invite.
    const again = await signedInPage(browser, { role: 'viewer' });
    const people = await authDoor<{ email: string }[]>(again, 'list-members');
    expect(people.filter((m) => m.email === ROLE_PEOPLE.viewer.email).length).toBe(1);

    for (const page of [viewer, admin, again]) await page.context().close();
  });
});
