import { expect, test } from '@playwright/test';
import { ownerState } from './helpers/auth';
import { expectNoSideScroll, setTheme, shot, shotThemes, shotView, watch } from './helpers/screen';

test.use({ storageState: ownerState });

const sidebar = (page: import('@playwright/test').Page) => page.getByRole('complementary');

test('lists every module, filters and searches them', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/modules');
  await expect(page.getByRole('heading', { name: 'Modules', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Modules' }).first()).toBeVisible();
  for (const name of ['Feedback', 'Forms', 'Links', 'Monitor', 'Waitlist']) {
    await expect(page.locator('.mod-card').getByRole('link', { name, exact: true })).toBeVisible();
  }
  await shotThemes(page, 'modules');

  await page.getByRole('navigation', { name: 'Filter modules' }).getByRole('link', { name: /^On/ }).click();
  await expect(page).toHaveURL(/filter=on/);
  await expect(page.locator('.mod-card')).toHaveCount(0);
  await shot(page, 'modules-empty-on');

  await page.goto('/app/modules');
  await page.getByLabel('Search modules').fill('zzzz');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('No modules match “zzzz”')).toBeVisible();
  await shot(page, 'modules-no-match');
  await page.getByLabel('Search modules').fill('wait');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page.locator('.mod-card')).toHaveCount(1);
  w.expectClean();
});

test('turning a module on shows it in the sidebar, turning it off asks first and removes it', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/modules');
  await expect(sidebar(page).getByRole('link', { name: /^Links\b/ })).toHaveCount(0);

  await page.getByRole('button', { name: 'Turn on Links' }).click();
  await expect(page.getByText('Links is on. It shows up in the sidebar.')).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: /^Links\b/ })).toBeVisible();
  await shot(page, 'modules-flash-on');

  await page.getByRole('button', { name: 'Turn off Links' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('Turn off Links?')).toBeVisible();
  await shotView(page, 'modules-confirm-dialog');
  // Cancelling leaves it on.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(sidebar(page).getByRole('link', { name: /^Links\b/ })).toBeVisible();

  await page.getByRole('button', { name: 'Turn off Links' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Links is off.')).toBeVisible();
  await expect(sidebar(page).getByRole('link', { name: /^Links\b/ })).toHaveCount(0);
  w.expectClean();
});

test('a module page shows its status and the same switch', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/modules/forms');
  await expect(page.getByRole('heading', { name: 'Forms', level: 1 })).toBeVisible();
  await expect(page.getByText('About this module')).toBeVisible();
  await shotThemes(page, 'modules-detail');
  await page.getByRole('button', { name: 'Turn on Forms' }).click();
  await expect(page).toHaveURL(/\/app\/modules\/forms$/);
  await expect(page.getByText('Forms is on.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn off Forms' })).toBeVisible();
  await setTheme(page, 'dark');
  await shot(page, 'modules-detail-on-dark');
  await page.getByRole('button', { name: 'Turn off Forms' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Forms is off.')).toBeVisible();
  w.expectClean();
});

test('an unknown module is a plain not-found page, and the page holds at 375 px', async ({ page }) => {
  const res = await page.goto('/app/modules/not-a-module');
  expect(res?.status()).toBe(404);
  await expect(page.getByText('There is no module with that name')).toBeVisible();
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/modules');
  await expectNoSideScroll(page);
});
