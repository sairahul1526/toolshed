import { expect, test } from '@playwright/test';
import { acceptInvite, authDoor, FIRST_WORKSPACE, outboxMark, OWNER_EMAIL, ownerState, readLink, ROLE_PEOPLE, signedInPage, signInAs } from './helpers/auth';

test.describe('an install that global setup claimed', () => {
  test('shows "already claimed" to a visitor', async ({ page }) => {
    await page.goto('/setup');
    await expect(page.getByRole('heading', { name: 'This Toolshed already has an owner' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
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
  // Opening the link is not enough.
  expect((await page.request.get('/app', { maxRedirects: 0 })).status()).toBe(302);
  await page.getByRole('button', { name: 'Finish signing in' }).click();
  await expect(page).toHaveURL(/\/app/);
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

    const guest = await (await browser.newContext()).newPage();
    await guest.goto(path);
    await expect(guest.getByRole('heading', { name: `Join ${FIRST_WORKSPACE}` })).toBeVisible();
    await expect(guest.getByText('guest@example.com').first()).toBeVisible();
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
