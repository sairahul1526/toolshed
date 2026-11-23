import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, watch } from './helpers/screen';

test.use({ storageState: ownerState });

async function setLinks(page: Page, enabled: '0' | '1') {
  const res = await page.request.post(`${baseURL}/app/modules/links/toggle`, { form: { enabled }, headers: { origin: baseURL }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
}

test('with no module on it says so and points to the modules', async ({ page }) => {
  const w = watch(page);
  await setLinks(page, '0');
  await page.goto('/app');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No modules are on yet' })).toBeVisible();
  // "No activity yet" is checked in test/dashboard: other test files leave activity behind here.
  await expect(page.getByRole('heading', { name: 'Recent activity' })).toBeVisible();
  await shotThemes(page, 'overview-empty');
  await page.getByRole('link', { name: 'Browse modules' }).click();
  await expect(page).toHaveURL(/\/app\/modules/);
  w.expectClean();
});

test('a turned-on module gets a card with its numbers, and the range switches', async ({ page }) => {
  const w = watch(page);
  await setLinks(page, '1');
  try {
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'No modules are on yet' })).toHaveCount(0);
    const cards = page.getByRole('region', { name: 'Modules' }).or(page.getByRole('group', { name: 'Modules' }));
    await expect(cards.getByRole('link', { name: 'Links' }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Last 30 days' })).toHaveAttribute('aria-current', /.+/);
    // The card's number is the module's own count, the same one the sidebar shows.
    const sidebar = (await page.getByRole('complementary', { name: 'Main' }).getByRole('link', { name: /^Links\b/ }).innerText()).match(/\d+/)?.[0];
    expect(sidebar).toBeDefined();
    await expect(cards.getByText(/Clicks, last 7 days/)).toBeVisible();
    await shotThemes(page, 'overview-cards');

    await page.getByRole('link', { name: 'Last 7 days' }).click();
    await expect(page).toHaveURL(/days=7/);
    await expect(page.getByRole('link', { name: 'Last 7 days' })).toHaveAttribute('aria-current', /.+/);
    // Nonsense in the address falls back to the default instead of breaking.
    await page.goto('/app?days=banana');
    await expect(page.getByRole('link', { name: 'Last 30 days' })).toHaveAttribute('aria-current', /.+/);
    w.expectClean();
  } finally {
    await setLinks(page, '0');
  }
});

test('the page holds at 375 px', async ({ page }) => {
  await setLinks(page, '1');
  try {
    await page.setViewportSize({ width: 375, height: 800 });
    for (const path of ['/app', '/app?days=7']) {
      await page.goto(path);
      await expectNoSideScroll(page);
    }
  } finally {
    await setLinks(page, '0');
  }
});
