import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { disableModule, enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner walks the Analytics module through the real pages: the first-run screen, adding a site,
// the install steps, goals, a share link, export and settings, then the sample site. A visitor in
// another browser context opens the public share page. Tests run in order and share one database.
// No request leaves the machine: anything that is not the local server gets an empty answer.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

let siteUrl = '';
let shareUrl = '';

async function blockOutside(page: Page): Promise<void> {
  await page.route(
    (url) => !url.href.startsWith(baseURL) && !/^(data|blob):/.test(url.href),
    (route) => route.fulfill({ status: 204, body: '' }),
  );
}

test.afterAll(async ({ browser }) => {
  await disableModule(browser, 'analytics');
});

test('turns on and shows the first-run screen with the sample offer', async ({ page }) => {
  const w = watch(page);
  await blockOutside(page);
  await enableModule(page, 'analytics');
  await page.goto('/app/analytics');
  await expect(page.getByRole('heading', { name: 'Analytics', level: 1 })).toBeVisible();
  await expect(page.getByText('No sites yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add the sample site' })).toBeVisible();
  await shoot(page, 'analytics', 'first-run');
  expect(w.problems).toEqual([]);
});

test('adding a site refuses a bad domain, then shows the install steps', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/analytics/new');
  await expect(page.getByRole('heading', { name: 'Add a site', level: 1 })).toBeVisible();
  await page.getByLabel('Domain').fill('not a domain!!');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await shoot(page, 'analytics', 'new-error');

  await page.getByLabel('Domain').fill('example.com');
  await page.getByRole('button', { name: 'Add site' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByText('Step 2 of 3. Paste this line')).toBeVisible();
  await expect(page.getByText('Waiting for the first page view')).toBeVisible();
  siteUrl = page.url().replace(/\/setup$/, '');
  await shoot(page, 'analytics', 'setup');
  expect(w.problems).toEqual([]);
});

test('the dashboard of a new site waits for the first visit and points to the install steps', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/analytics');
  await expect(page.getByRole('link', { name: /example\.com/ }).first()).toBeVisible();
  await shoot(page, 'analytics', 'list');
  await page.goto(siteUrl);
  await expect(page.getByText('Waiting for the first page view')).toBeVisible();
  await page.getByRole('link', { name: 'See the install steps' }).click();
  await expect(page).toHaveURL(/\/setup$/);
  await shoot(page, 'analytics', 'report-empty');
  expect(w.problems).toEqual([]);
});

test('goals and events: a goal is added and listed', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${siteUrl}/goals`);
  await shoot(page, 'analytics', 'goals');
  await page.getByLabel('Event name or page path').fill('Signup');
  await page.getByLabel('Name', { exact: false }).last().fill('Sign-ups');
  await page.getByRole('button', { name: 'Add goal' }).click();
  await expect(page.getByText('Sign-ups').first()).toBeVisible();
  await shoot(page, 'analytics', 'goal-added');
  expect(w.problems).toEqual([]);
});

test('makes a share link, and a visitor opens the public page', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`${siteUrl}/share`);
  await page.getByRole('button', { name: 'Make link' }).click();
  await expect(page.getByText('Anyone with the link', { exact: true })).toBeVisible();
  shareUrl = (await page.content()).match(/\/a\/share\/[A-Za-z0-9_-]+/)?.[0] ?? '';
  expect(shareUrl).not.toBe('');
  await shoot(page, 'analytics', 'share');

  const visitor = await (await browser.newContext({ baseURL })).newPage();
  const vw = watch(visitor);
  await visitor.goto(shareUrl);
  await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
  await shoot(visitor, 'analytics', 'public-share');
  expect(vw.problems).toEqual([]);
  await visitor.context().close();
  expect(w.problems).toEqual([]);
});

test('export and settings open without trouble', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${siteUrl}/export`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shoot(page, 'analytics', 'export');
  await page.goto(`${siteUrl}/settings`);
  await expect(page.getByLabel('Domain', { exact: true })).toHaveValue('example.com');
  await shoot(page, 'analytics', 'settings');
  expect(w.problems).toEqual([]);
});

test('the sample site fills the screens', async ({ page }) => {
  const w = watch(page);
  // The offer shows only while there are no sites, so the same form post is sent from here.
  await page.goto('/app/analytics');
  const res = await page.request.post(`${baseURL}/app/analytics/sample`, { form: { on: '1' }, headers: { origin: baseURL }, maxRedirects: 0 });
  expect(res.status()).toBe(303);
  await page.goto('/app/analytics');
  await expect(page.getByText('The sample site is on')).toBeVisible();
  await shoot(page, 'analytics', 'list-sample');
  await page.getByRole('link', { name: /sample/i }).first().click();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  const sample = page.url().split('?')[0]!;
  await shoot(page, 'analytics', 'report-sample');
  await page.goto(`${sample}/breakdown/page`);
  await shoot(page, 'analytics', 'breakdown');
  await page.goto(`${sample}/goals`);
  await shoot(page, 'analytics', 'goals-sample');
  expect(w.problems).toEqual([]);
});

test('every screen fits a 375 px phone without sideways scroll', async ({ page }) => {
  await blockOutside(page);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/analytics', '/app/analytics/new', `${siteUrl}/setup`, siteUrl, `${siteUrl}/goals`, `${siteUrl}/share`, `${siteUrl}/export`, `${siteUrl}/settings`]) {
    await page.goto(path.replace(baseURL, ''));
    await expectNoSideScroll(page);
  }
});
