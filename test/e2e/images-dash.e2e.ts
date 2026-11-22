import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { disableModule, enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner walks the Images module through the real pages: the first-run screen, making a
// template from a starter, the editor with its folded side panel, the template settings, the
// asset library, batch, usage and the module settings. A visitor in another browser context then
// opens the public generator page. Tests run in order and share one database. No request leaves
// the machine: anything that is not the local server is answered with an empty page.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

let templateUrl = '';
let makePath = '';

async function blockOutside(page: Page): Promise<void> {
  await page.route(
    (url) => !url.href.startsWith(baseURL) && !url.protocol.startsWith('data') && !url.protocol.startsWith('blob'),
    (route) => route.fulfill({ status: 204, body: '' }),
  );
}

test.afterAll(async ({ browser }) => {
  await disableModule(browser, 'images');
});

test('turns on and shows the first-run screen with the starter cards clear of the button', async ({ page }) => {
  const w = watch(page);
  await blockOutside(page);
  await enableModule(page, 'images');
  await page.goto('/app/images');
  await expect(page.getByRole('heading', { name: 'Images', level: 1 })).toBeVisible();

  // The "See all" link sits under the starters with space between it and every "Use this card" button.
  const see = page.getByRole('link', { name: /See all/ });
  await expect(see).toBeVisible();
  const use = page.getByRole('button', { name: /Use the .* card/ });
  expect(await use.count()).toBeGreaterThan(1);
  const seeBox = await see.boundingBox();
  const lastUse = await use.last().boundingBox();
  expect(seeBox && lastUse).toBeTruthy();
  expect(seeBox!.y - (lastUse!.y + lastUse!.height), 'the button touches the starter cards').toBeGreaterThanOrEqual(8);
  await shoot(page, 'images', 'first-run');
  expect(w.problems).toEqual([]);
});

test('the new template screen refuses an empty import, with the message shown', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/images/new');
  await expect(page.getByRole('heading', { name: 'New template', level: 1 })).toBeVisible();
  await shoot(page, 'images', 'new');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('That didn’t work')).toBeVisible();
  await shoot(page, 'images', 'new-import-error');
  expect(w.problems).toEqual([]);
});

test('a starter makes a template, and its use page lists the next steps', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/images/new');
  await page.getByRole('button', { name: /Use the .* card/ }).first().click();
  await page.waitForLoadState();
  await expect(page).toHaveURL(/\/app\/images\/t\/[^/]+$/);
  templateUrl = page.url();
  await expect(page.getByRole('link', { name: 'Design' }).first()).toBeVisible();
  await shoot(page, 'images', 'template-use');
  expect(w.problems).toEqual([]);
});

test('the editor folds its side panel into Layers, Fields and Settings so the preview stays in view', async ({ page }) => {
  const w = watch(page);
  await blockOutside(page);
  await page.goto(templateUrl);
  await page.getByRole('link', { name: 'Design' }).first().click();
  await expect(page.locator('.img-ed-canvas')).toBeVisible();

  const sections = page.locator('.img-ed-sect');
  await expect(sections).toHaveCount(3);
  await expect(sections.nth(0).locator(':scope > summary')).toHaveText('Layers');
  await expect(sections.nth(1).locator(':scope > summary')).toHaveText('Fields');
  await expect(sections.nth(2).locator(':scope > summary')).toHaveText('Settings');
  await expect(sections.nth(0)).toHaveJSProperty('open', true);
  await expect(sections.nth(1)).toHaveJSProperty('open', false);

  // The preview is in the first screen, not pushed below a tall side panel.
  const box = await page.locator('.img-ed-canvas').boundingBox();
  const view = page.viewportSize()!;
  expect(box!.y + Math.min(box!.height, 200)).toBeLessThan(view.height);
  await shoot(page, 'images', 'design');

  await sections.nth(1).locator(':scope > summary').click();
  await expect(sections.nth(1)).toHaveJSProperty('open', true);
  const field = page.locator('.img-ed-fieldset > summary').first();
  await field.click();
  await expect(page.locator('.img-ed-fieldset').first()).toHaveJSProperty('open', true);
  await shoot(page, 'images', 'design-fields');

  await page.locator('.img-ed-layer-name').first().click();
  await expect(page.locator('.img-ed-props textarea, .img-ed-props input').first()).toBeVisible();
  await shoot(page, 'images', 'design-layer');
  expect(w.problems).toEqual([]);
});

test('template settings turn on the public generator page', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${templateUrl}/settings`);
  await page.getByLabel('Public generator page').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByLabel('Public generator page')).toBeChecked();
  const html = await page.content();
  makePath = html.match(/\/i\/[A-Za-z0-9_-]+\/make/)?.[0] ?? '';
  if (!makePath) {
    const slug = html.match(/\/i\/([A-Za-z0-9_-]+)/)?.[1];
    expect(slug, 'the settings page shows the public address').toBeTruthy();
    makePath = `/i/${slug}/make`;
  }
  await shoot(page, 'images', 'template-settings');
  expect(w.problems).toEqual([]);
});

test('the list, assets, batch, usage and settings screens open without trouble', async ({ page }) => {
  const w = watch(page);
  await blockOutside(page);
  await page.goto('/app/images');
  await expect(page.getByRole('link', { name: /Design/ }).first()).toBeVisible();
  await shoot(page, 'images', 'list');

  await page.goto('/app/images/assets');
  await shoot(page, 'images', 'assets');
  // A one pixel PNG, sent from memory: the form accepts it and the picture shows in the list.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type="file"]').setInputFiles({ name: 'dot.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('dot.png').first()).toBeVisible();
  await shoot(page, 'images', 'assets-uploaded');

  for (const [path, name] of [
    ['/app/images/batch', 'batch'],
    ['/app/images/usage', 'usage'],
    ['/app/images/settings', 'settings'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await shoot(page, 'images', name);
  }
  expect(w.problems).toEqual([]);
});

test('a visitor opens the public generator page', async ({ browser }) => {
  expect(makePath).not.toBe('');
  const visitor = await (await browser.newContext({ baseURL })).newPage();
  const w = watch(visitor);
  await blockOutside(visitor);
  await visitor.goto(makePath);
  await expect(visitor.getByRole('heading', { level: 1 })).toBeVisible();
  await shoot(visitor, 'images', 'public-make');
  expect(w.problems).toEqual([]);
  await visitor.context().close();
});

test('every screen fits a 375 px phone without sideways scroll', async ({ page }) => {
  await blockOutside(page);
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/images', '/app/images/new', templateUrl.replace(baseURL, ''), '/app/images/assets', '/app/images/batch', '/app/images/usage', '/app/images/settings']) {
    await page.goto(path);
    await expectNoSideScroll(page);
  }
  await page.goto(`${templateUrl}/edit`);
  await expect(page.locator('.img-ed-canvas')).toBeVisible();
  await expectNoSideScroll(page);
});
