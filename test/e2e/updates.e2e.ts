import { expect, test } from '@playwright/test';
import { ownerState } from './helpers/auth';
import { expectNoSideScroll, shotThemes, shotView, watch } from './helpers/screen';

test.use({ storageState: ownerState });

test('the Owner section links to Updates, and the page says what is running and how to update', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app');
  await page.getByRole('link', { name: 'Updates' }).click();
  await expect(page).toHaveURL(/\/app\/updates$/);
  await expect(page.getByRole('heading', { name: 'Updates', level: 1 })).toBeVisible();
  await expect(page.getByText(/^Version \d+\.\d+\.\d+/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How to update' })).toBeVisible();
  await expect(page.getByText('npx wrangler deploy')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Applied database changes' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Installed modules' })).toBeVisible();
  // A fresh install has no failed jobs, and the page says so rather than showing an empty table.
  await expect(page.getByText('No failed jobs')).toBeVisible();
  await shotThemes(page, 'updates');
  w.expectClean();
});

test('a command can be copied from its block', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/app/updates');
  await page.getByRole('button', { name: 'Copy deploy' }).click();
  await expect.poll(() => page.evaluate<string>('navigator.clipboard.readText()')).toBe('npx wrangler deploy');
  await shotView(page, 'updates-copied');
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/updates');
  await expectNoSideScroll(page);
});
