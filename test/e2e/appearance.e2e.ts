import { expect, test } from '@playwright/test';
import { ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';

test.use({ storageState: ownerState });

const html = (page: import('@playwright/test').Page, attr: string) => page.locator('html').getAttribute(attr);

test('changing the look is saved for the workspace and applied after a reload', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/appearance');
  await expect(page.getByRole('heading', { name: 'Appearance', level: 1 })).toBeVisible();
  expect(await html(page, 'data-accent')).toBe('lime');
  await shotThemes(page, 'appearance');

  await page.getByText('Violet', { exact: true }).click();
  await page.getByText('Dark for everyone by default.').click();
  await page.getByText('Cobalt', { exact: true }).click();
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText('Appearance saved for everyone in this workspace.')).toBeVisible();
  await shot(page, 'appearance-saved');

  await page.reload();
  expect(await html(page, 'data-accent')).toBe('violet');
  expect(await html(page, 'data-mode')).toBe('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('radio', { name: /^Violet/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /^Cobalt/ })).toBeChecked();
  await shot(page, 'appearance-violet-dark');

  // Saving the same thing again says so instead of writing an entry.
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText('Nothing changed, so nothing was saved.')).toBeVisible();
  w.expectClean();
});

test('a bad logo address is refused next to the field and what was typed is kept', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/appearance');
  await page.getByLabel('Logo address').fill('not a web address');
  await page.getByRole('button', { name: 'Save appearance' }).click();
  const field = page.getByLabel('Logo address');
  await expect(field).toHaveValue('not a web address');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.field-error, [role="alert"], .err').first()).toBeVisible();
  await shot(page, 'appearance-error');

  await page.getByLabel('Logo address').fill('http://example.com/logo.png');
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByLabel('Logo address')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Logo address').fill('https://example.com/logo.png');
  await page.getByRole('button', { name: 'Save appearance' }).click();
  await expect(page.getByText('Appearance saved for everyone in this workspace.')).toBeVisible();
  await expect(page.getByLabel('Logo address')).toHaveValue('https://example.com/logo.png');
  w.expectClean(['response 422', 'status of 422']);
});

test('reset asks first, then puts every default back', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/appearance');
  await page.getByRole('button', { name: 'Reset to defaults' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Reset to the Toolshed defaults?')).toBeVisible();
  await shotView(page, 'appearance-confirm-dialog');
  await dialog.getByRole('button', { name: 'Reset appearance' }).click();
  await expect(page.getByText('Appearance is back to the Toolshed defaults.')).toBeVisible();
  expect(await html(page, 'data-accent')).toBe('lime');
  expect(await html(page, 'data-mode')).toBe('system');
  await expect(page.getByLabel('Logo address')).toHaveValue('');
  await expect(page.getByRole('radio', { name: /^Paper/ })).toBeChecked();
  w.expectClean();
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/appearance');
  await expectNoSideScroll(page);
});
