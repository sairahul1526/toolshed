import { expect, test } from '@playwright/test';
import { RUN, signedInPage } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, shotView, watch } from './helpers/screen';

test('the name and address are saved, refused when wrong, and explained when taken', async ({ browser }) => {
  const page = await signedInPage(browser, { workspace: `Rename Me ${RUN}` });
  const w = watch(page);
  await page.goto('/app/settings');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Webhooks' })).toBeVisible();
  await shotThemes(page, 'settings-general');

  await page.getByLabel('Name', { exact: true }).fill('   ');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Address')).toHaveValue(/.+/);
  await shot(page, 'settings-general-error');

  await page.getByLabel('Name', { exact: true }).fill(`Renamed ${RUN}`);
  await page.getByLabel('Address').fill(`renamed-${RUN}`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Workspace saved.')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue(`Renamed ${RUN}`);
  await expect(page.getByLabel('Address')).toHaveValue(`renamed-${RUN}`);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Nothing changed, so nothing was saved.')).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
  await page.context().close();
});

test('webhooks: add one, see its secret once, change it, pause it and delete it', async ({ browser }) => {
  const page = await signedInPage(browser, { workspace: `Hooks ${RUN}` });
  const w = watch(page);
  await page.goto('/app/settings?tab=webhooks');
  await expect(page.getByRole('heading', { name: 'No webhooks yet' })).toBeVisible();
  await shotThemes(page, 'settings-webhooks-empty');

  await page.getByRole('link', { name: 'Add webhook' }).first().click();
  await expect(page.getByRole('heading', { name: 'Add a webhook', level: 1 })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Orders');
  await page.getByLabel('Address', { exact: true }).fill('http://hooks.example.com/in');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByLabel('Address', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByText('Pick at least one event')).toBeVisible();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Orders');
  await shot(page, 'settings-webhooks-error');

  await page.getByLabel('Address', { exact: true }).fill('https://hooks.example.com/in');
  await page.getByLabel('Everything').check();
  await page.getByRole('button', { name: 'Add webhook' }).click();
  await expect(page.getByRole('heading', { name: 'Webhook added', level: 1 })).toBeVisible();
  const secret = (await page.locator('.secret code').first().innerText()).trim();
  expect(secret).toMatch(/^whsec_/);
  await shotThemes(page, 'settings-webhooks-secret');
  await page.getByRole('link', { name: 'I copied it' }).click();
  await expect(page.locator('body')).not.toContainText(secret);
  await expect(page.getByRole('heading', { name: 'Orders', level: 1 })).toBeVisible();
  await shot(page, 'settings-webhook-page');

  await page.getByLabel('Name', { exact: true }).fill('Orders to the warehouse');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved Orders to the warehouse.')).toBeVisible();

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Paused Orders to the warehouse.')).toBeVisible();
  await page.getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByText('Orders to the warehouse is on.')).toBeVisible();

  await page.getByRole('button', { name: 'Show secret' }).click();
  await expect(page.getByRole('heading', { name: 'Signing secret', level: 1 })).toBeVisible();
  expect((await page.locator('.secret code').first().innerText()).trim()).toBe(secret);
  await page.getByRole('link', { name: 'Back to the webhook' }).click();

  await page.getByRole('button', { name: 'Delete webhook' }).click();
  await expect(page.getByText('Deleted Orders to the warehouse.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No webhooks yet' })).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
  await page.context().close();
});

test('data: an export is asked for and listed', async ({ browser }) => {
  const page = await signedInPage(browser, { workspace: `Export ${RUN}` });
  const w = watch(page);
  await page.goto('/app/settings?tab=data');
  await expect(page.getByRole('heading', { name: 'No exports yet' })).toBeVisible();
  await shotThemes(page, 'settings-data');
  await page.getByRole('button', { name: 'Start export' }).click();
  await expect(page.getByText(/Export started|already running/)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No exports yet' })).toHaveCount(0);
  await expect(page.getByText(/Waiting|Preparing|Ready|Failed/).first()).toBeVisible();
  await shot(page, 'settings-data-export');
  await expectNoSideScroll(page);
  w.expectClean();
  await page.context().close();
});

test('data: deleting the workspace needs its address typed, then it is gone', async ({ browser }) => {
  const name = `Doomed ${RUN}`;
  const page = await signedInPage(browser, { workspace: name });
  const w = watch(page);
  await page.goto('/app/settings?tab=data');
  const slug = await page.getByLabel(/^Type .* to confirm$/).getAttribute('placeholder');
  expect(slug).toBeTruthy();
  await page.getByLabel(/^Type .* to confirm$/).fill('not-the-address');
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await expect(page.getByLabel(/^Type .* to confirm$/)).toHaveAttribute('aria-invalid', 'true');
  await shot(page, 'settings-delete-error');

  await page.getByLabel(/^Type .* to confirm$/).fill(slug!);
  await page.getByRole('button', { name: 'Delete workspace' }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/app/settings'));
  await page.goto('/app/settings');
  await expect(page.getByLabel('Name', { exact: true })).not.toHaveValue(name);
  w.expectClean(['response 422', 'status of 422']);
  await page.context().close();
});

test('a viewer can look, not change', async ({ browser }) => {
  const page = await signedInPage(browser, { role: 'viewer' });
  const w = watch(page);
  await page.goto('/app/settings');
  await expect(page.getByText('You can look, not change')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await page.goto('/app/settings?tab=webhooks');
  await expect(page.getByText('Admins only')).toBeVisible();
  await page.goto('/app/settings?tab=data');
  await expect(page.getByText('Owners only')).toBeVisible();
  await shotView(page, 'settings-viewer-375');
  w.expectClean();
  await page.context().close();
});
