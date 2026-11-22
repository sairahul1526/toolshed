import { expect, test } from '@playwright/test';
import { OWNER_EMAIL, ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';

test.use({ storageState: ownerState });

test('opens on setup, with the status and the sender form', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/email');
  await expect(page.getByRole('heading', { name: 'Email', level: 1 })).toBeVisible();
  await expect(page.getByText('Development mode', { exact: true })).toBeVisible();
  await expect(page.getByLabel('From name')).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Email sections' }).getByRole('link')).toHaveCount(4);
  await shotThemes(page, 'email');
  w.expectClean();
});

test('the sender is checked by its fields, then saved', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/email?tab=setup');
  // Skip the browser's own checks so the server's messages are the ones tested.
  await page.locator('form[action="/app/email/sender"]').evaluate((f) => ((f as unknown as { noValidate: boolean }).noValidate = true));
  await page.getByLabel('From name').fill('   ');
  await page.getByLabel('From address').fill('not-an-address');
  await page.getByLabel('Replies go to').fill('also not');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  for (const label of ['From name', 'From address', 'Replies go to']) {
    await expect(page.getByLabel(label)).toHaveAttribute('aria-invalid', 'true');
  }
  await expect(page.getByLabel('From address')).toHaveValue('not-an-address');
  await shot(page, 'email-error');

  await page.getByLabel('From name').fill('Toolshed Test');
  await page.getByLabel('From address').fill('hello@example.com');
  await page.getByLabel('Replies go to').fill('help@example.com');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText('Sender saved.')).toBeVisible();
  await expect(page.getByLabel('From address')).toHaveValue('hello@example.com');
  w.expectClean(['response 422', 'status of 422']);
});

test('a test email is sent and lands in the delivery log', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/email?tab=setup');
  await page.locator('form[action="/app/email/test"]').evaluate((f) => ((f as unknown as { noValidate: boolean }).noValidate = true));
  await page.getByLabel('Send it to').fill('nope');
  await page.getByRole('button', { name: /Send test|Send/ }).last().click();
  await expect(page.getByLabel('Send it to')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Send it to').fill(OWNER_EMAIL);
  await page.getByRole('button', { name: /Send test|Send/ }).last().click();
  await expect(page.getByLabel('Send it to')).not.toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'email-test-sent');

  await page.goto('/app/email?tab=log');
  await expect(page.getByRole('heading', { name: 'Delivery log' })).toBeVisible();
  // The list hides most of the address; the details below show all of it.
  const row = page.getByRole('row').filter({ hasText: 'o***@example.com' }).first();
  await expect(row).toBeVisible();
  await expect(row).not.toContainText(OWNER_EMAIL);
  await shotThemes(page, 'email-log');
  await row.getByRole('button', { name: /Details|Open|View/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Email details' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(OWNER_EMAIL)).toBeVisible();
  await shotView(page, 'email-log-details');
  await dialog.getByRole('button', { name: 'Close', exact: true }).last().click();
  await expect(dialog).toBeHidden();

  // Filter: a search nobody matches says so.
  await page.getByRole('searchbox', { name: 'Search by address or subject' }).fill('zzzz-nobody');
  await page.getByRole('searchbox', { name: 'Search by address or subject' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'No emails match' })).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
});

test('templates can be previewed, and the blocked tab starts empty', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/email?tab=templates');
  await expect(page.getByRole('list', { name: 'Templates' }).getByRole('listitem').first()).toBeVisible();
  await page.getByRole('list', { name: 'Templates' }).getByRole('link').first().click();
  await expect(page.getByText('Plain-text version')).toBeVisible();
  await shot(page, 'email-templates');
  await page.goto('/app/email?tab=blocked');
  await expect(page.getByRole('heading', { name: /Blocked addresses|No blocked/ }).first()).toBeVisible();
  await shot(page, 'email-blocked');
  w.expectClean();
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const tab of ['setup', 'templates', 'log', 'blocked']) {
    await page.goto(`/app/email?tab=${tab}`);
    await expectNoSideScroll(page);
  }
});
