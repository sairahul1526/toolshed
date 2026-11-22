import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, watch } from './helpers/screen';

test.use({ storageState: ownerState });

/** A finished workspace export is the one real thing that notifies the person who asked for it. */
async function makeNotification(page: Page): Promise<void> {
  const count = async () => ((await (await page.request.get(`${baseURL}/api/v1/notifications`)).text()).match(/Your export is ready/g) ?? []).length;
  const before = await count();
  const res = await page.request.post(`${baseURL}/api/v1/export`, { headers: { origin: baseURL } });
  expect(res.status()).toBe(202);
  await expect.poll(count, { timeout: 30_000, intervals: [500] }).toBeGreaterThan(before);
}

test('an empty inbox says so, with its own unread filter', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You are all caught up' })).toBeVisible();
  await shotThemes(page, 'notifications-empty');
  await page.goto('/app/notifications?filter=unread');
  await expect(page.getByRole('navigation', { name: 'Show' }).getByRole('link', { name: /^Unread/ })).toHaveAttribute('aria-current', 'page');
  w.expectClean();
});

test('a finished export shows up, can be marked read one by one, and everything can be marked read', async ({ page }) => {
  const w = watch(page);
  await makeNotification(page);
  await makeNotification(page);
  await page.goto('/app/notifications');
  const items = page.getByRole('list', { name: 'Notifications' }).getByRole('listitem');
  await expect(items.first()).toContainText('Your export is ready');
  expect(await items.count()).toBeGreaterThanOrEqual(2);
  await shotThemes(page, 'notifications');

  const unreadBefore = await page.getByRole('button', { name: /Mark as read/ }).count();
  expect(unreadBefore).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: /Mark as read/ }).first().click();
  await expect(page.getByText('Marked as read.')).toBeVisible();
  expect(await page.getByRole('button', { name: /Mark as read/ }).count()).toBe(unreadBefore - 1);

  await page.getByRole('button', { name: 'Mark all as read' }).click();
  await expect(page.getByText('All notifications marked as read.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark all as read' })).toHaveCount(0);
  await shot(page, 'notifications-all-read');

  await page.goto('/app/notifications?filter=unread');
  await expect(page.getByText('Nothing unread')).toBeVisible();
  await shot(page, 'notifications-nothing-unread');
  await page.getByRole('link', { name: 'Show all' }).click();
  await expect(items.first()).toContainText('Your export is ready');
  w.expectClean();
});

test('opening one goes to its link, and the page holds at 375 px', async ({ page }) => {
  await makeNotification(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/app/notifications');
  await expectNoSideScroll(page);
  await shot(page, 'notifications-375-list');
  const link = page.getByRole('list', { name: 'Notifications' }).getByRole('link').first();
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/app\/notifications\/[^/]+\/open$/);
  const res = await page.request.get(`${baseURL}${href}`, { maxRedirects: 0 });
  expect(res.status()).toBe(303);
  expect(res.headers().location).toMatch(/^\/api\/v1\/export\/.+\/download$/);
});
