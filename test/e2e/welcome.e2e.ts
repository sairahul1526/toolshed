import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, watch } from './helpers/screen';

test.use({ storageState: ownerState });

async function setLinks(page: Page, enabled: '0' | '1') {
  const res = await page.request.post(`${baseURL}/app/modules/links/toggle`, { form: { enabled }, headers: { origin: baseURL }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
}

test('Get started shows the cards, the steps and this install', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/welcome');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome to Toolshed.');
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sample data' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'This install' })).toBeVisible();
  await expect(page.getByRole('progressbar')).toBeVisible();
  // The owner claimed the install and named a workspace during setup, so those two are ticked.
  await expect(page.locator('ul.rows li.done')).not.toHaveCount(0);
  await expect(page.getByRole('link', { name: /See all \d+ modules/ })).toBeVisible();
  // The sidebar entry carries the same count as the card.
  await expect(page.locator('nav a[href="/app/welcome"]')).toHaveAttribute('aria-current', 'page');
  await shotThemes(page, 'welcome');
  w.expectClean();
});

test('a card turns its module on and opens it', async ({ page }) => {
  const w = watch(page);
  await setLinks(page, '0');
  try {
    await page.goto('/app/welcome');
    await page.getByRole('button', { name: /Shorten a link/ }).click();
    await expect(page).toHaveURL(/\/app\/links/);
    await expect(page.getByText(/Links is on/)).toBeVisible();
    // Back on Get started the card is a link now and the step is ticked.
    await page.goto('/app/welcome');
    await expect(page.getByRole('button', { name: /Shorten a link/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Shorten a link/ })).toBeVisible();
    await expect(page.locator('ul.rows li.done', { hasText: 'Turn on a module' })).toBeVisible();
    w.expectClean();
  } finally {
    await setLinks(page, '0');
  }
});

test('the sample data switch turns off and back on', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/welcome');
  const sw = page.getByRole('switch', { name: 'Sample data' });
  await expect(sw).toHaveAttribute('aria-checked', 'true');
  await sw.click();
  await expect(page.getByRole('switch', { name: 'Sample data' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByText(/Sample data (is off|removed)/)).toBeVisible();
  await shot(page, 'welcome-sample-off');
  await page.getByRole('switch', { name: 'Sample data' }).click();
  await expect(page.getByRole('switch', { name: 'Sample data' })).toHaveAttribute('aria-checked', 'true');
  w.expectClean();
});

test('Get started can leave the sidebar and come back', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/welcome');
  await page.getByRole('button', { name: 'Hide from sidebar' }).click();
  await expect(page.getByText('Get started is out of the sidebar.')).toBeVisible();
  await expect(page.locator('nav a[href="/app/welcome"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Finish setting up' })).toBeVisible();
  await page.getByRole('button', { name: 'Show in sidebar' }).click();
  await expect(page.locator('nav a[href="/app/welcome"]')).toHaveCount(1);
  w.expectClean();
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/welcome');
  await expectNoSideScroll(page);
  await expect(page.getByRole('button', { name: 'Hide from sidebar' })).toBeVisible();
});
