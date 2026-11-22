import { expect, test } from '@playwright/test';
import { ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';

test.use({ storageState: ownerState });

test('starts empty, with the way to make a key and the signing key for the install owner', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/api-keys');
  await expect(page.getByRole('heading', { name: 'API keys', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No keys yet' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Signing key' })).toBeVisible();
  await shotThemes(page, 'api-keys-empty');
  await page.getByRole('link', { name: 'Service accounts' }).click();
  await expect(page.getByRole('heading', { name: 'No service accounts yet' })).toBeVisible();
  w.expectClean();
});

test('a key is made, its secret is shown once, and it can be renamed, rotated and revoked', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/api-keys/new');
  await expect(page.getByRole('heading', { name: 'Make a key', level: 1 })).toBeVisible();

  // Nothing picked under "What it can do": the message sits by that group.
  await page.getByLabel('Name', { exact: true }).fill('Nightly backup');
  await page.getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByRole('alert').filter({ hasText: /permission|access|pick/i })).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Nightly backup');
  await shot(page, 'api-keys-new-error');

  // A name of only spaces is refused next to the name.
  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByLabel('Full access').check();
  await page.getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Name', { exact: true }).fill('Nightly backup');
  await page.getByLabel('Full access').check();
  await page.getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByRole('heading', { name: 'Copy your key now' })).toBeVisible();
  await expect(page.getByText('You won’t see this again')).toBeVisible();
  const secret = await page.locator('input[readonly]').first().inputValue();
  expect(secret.length).toBeGreaterThan(20);
  expect((await page.request.fetch(page.url(), { method: 'GET', failOnStatusCode: false })).status()).not.toBe(500);
  await shotThemes(page, 'api-keys-secret');

  await page.getByRole('link', { name: 'I copied it' }).click();
  await expect(page).toHaveURL(/\/app\/api-keys$/);
  await expect(page.locator('body')).not.toContainText(secret);
  await expect(page.getByRole('link', { name: 'Nightly backup' })).toBeVisible();
  await shot(page, 'api-keys-list');

  // The secret is gone from the key's own page too.
  await page.getByRole('link', { name: 'Nightly backup' }).click();
  await expect(page.getByRole('heading', { name: 'Nightly backup', level: 1 })).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secret);
  await shotThemes(page, 'api-keys-detail');

  // Rename, with an error by the field first.
  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Name', { exact: true }).fill('Nightly backup v2');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Renamed the key to Nightly backup v2.')).toBeVisible();

  // Rotate: the new secret is shown once, the old one stops at once.
  await page.getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await shotView(page, 'api-keys-confirm-rotate');
  await page.getByRole('dialog').getByRole('button', { name: /^Rotate/ }).last().click();
  await expect(page.getByRole('heading', { name: 'Copy your new key now' })).toBeVisible();
  const second = await page.locator('input[readonly]').first().inputValue();
  expect(second).not.toBe(secret);

  // Revoke through the confirm dialog.
  await page.getByRole('link', { name: 'I copied it' }).click();
  await page.getByRole('link', { name: 'Nightly backup v2' }).first().click();
  await page.getByRole('button', { name: 'Revoke key' }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Revoke Nightly backup v2?')).toBeVisible();
  await shotView(page, 'api-keys-confirm-revoke');
  await dialog.getByRole('button', { name: 'Revoke key' }).click();
  await expect(page.getByText('Revoked Nightly backup v2. Anything using it has stopped working.')).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
});

test('sending the make-a-key form twice makes one key', async ({ page }) => {
  await page.goto('/app/api-keys/new');
  await page.getByLabel('Name', { exact: true }).fill('Double click');
  await page.getByLabel('Full access').check();
  await page.getByRole('button', { name: 'Make key' }).click();
  await expect(page.getByRole('heading', { name: 'Copy your key now' })).toBeVisible();
  await page.reload();
  await expect(page).toHaveURL(/\/app\/api-keys$/);
  await expect(page.getByText(/already sent, so no second key was made/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Double click' })).toHaveCount(1);
});

test('a service account is made, checked and deleted', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/api-keys/accounts/new');
  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: /Make|Save|Create/ }).first().click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'api-keys-account-error');
  await page.getByLabel('Name', { exact: true }).fill('Zapier');
  await page.getByRole('button', { name: /Make|Save|Create/ }).first().click();
  await expect(page.getByText('Made the service account Zapier.')).toBeVisible();
  await shot(page, 'api-keys-account');
  await page.getByRole('button', { name: /^Delete/ }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: /^Delete/ }).click();
  await expect(page.getByText(/Deleted the service account Zapier/)).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/api-keys', '/app/api-keys/new', '/app/api-keys?revoked=1']) {
    await page.goto(path);
    await expectNoSideScroll(page);
  }
});
