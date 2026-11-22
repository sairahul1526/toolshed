import { expect, test } from '@playwright/test';
import { FIRST_WORKSPACE, OWNER_EMAIL, ownerState, signedInPage, signInAs } from './helpers/auth';

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

test('a second workspace is active for its own page only', async ({ browser }) => {
  const second = await signedInPage(browser, { workspace: 'Second Shed' });
  await expect(second.getByText('Second Shed').first()).toBeVisible();
  const first = await signedInPage(browser);
  await expect(first.getByText(FIRST_WORKSPACE).first()).toBeVisible();
  await second.context().close();
  await first.context().close();
});
