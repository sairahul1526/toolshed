import { expect, test, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { expectNoSideScroll, shot, shotThemes, watch } from './helpers/screen';

test.use({ storageState: ownerState });

/** Turn a module on and off through its own form, `times` rounds. Each change writes one entry. */
async function writeEntries(page: Page, rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    for (const enabled of ['1', '0']) {
      const res = await page.request.post(`${baseURL}/app/modules/links/toggle`, { form: { enabled }, headers: { origin: baseURL }, maxRedirects: 0 });
      expect(res.status()).toBe(303);
    }
  }
}

test('shows the entries earlier actions wrote, and each can be opened', async ({ page }) => {
  const w = watch(page);
  await writeEntries(page, 1);
  await page.goto('/app/audit-log');
  await expect(page.getByRole('heading', { name: 'Audit log', level: 1 })).toBeVisible();
  const table = page.getByRole('table', { name: 'Audit log entries, newest first' });
  await expect(table.getByRole('cell', { name: /Turned on Links/ }).first()).toBeVisible();
  await expect(table.getByRole('cell', { name: /Turned off Links/ }).first()).toBeVisible();
  await expect(table.getByText('owner@example.com').first()).toBeVisible();
  await table.getByText('Details').first().click();
  await expect(table.locator('details[open]')).toHaveCount(1);
  await shotThemes(page, 'audit-log');
  w.expectClean();
});

test('filters by search, action and date, and clears them', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/audit-log');
  const table = page.getByRole('table', { name: 'Audit log entries, newest first' });

  await page.getByRole('searchbox', { name: 'Search the audit log' }).fill('Turned on Links');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/q=Turned\+on\+Links|q=Turned%20on%20Links/);
  await expect(table.getByText('Turned on Links').first()).toBeVisible();
  await expect(table.getByText(/Turned off Links/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Clear filters' }).click();
  await page.getByLabel('Action').selectOption('module.disabled');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(table.getByText(/Turned off Links/).first()).toBeVisible();
  await expect(table.getByText('Turned on Links')).toHaveCount(0);

  // A day with nothing in it says so and offers a way out.
  await page.goto('/app/audit-log?from=2001-01-01&to=2001-01-02');
  await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
  await shot(page, 'audit-log-empty-filter');
  await page.getByRole('link', { name: 'Clear filters' }).first().click();
  await expect(page.getByRole('table', { name: 'Audit log entries, newest first' })).toBeVisible();

  // Today is included.
  const today = new Date().toISOString().slice(0, 10);
  await page.goto(`/app/audit-log?from=${today}&to=${today}`);
  await expect(page.getByText('Turned on Links').first()).toBeVisible();
  w.expectClean();
});

test('bad dates are refused with a message and the field marked', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/audit-log?from=nonsense&to=2026-02-31');
  await expect(page.getByText('Those filters need fixing')).toBeVisible();
  await expect(page.getByText('The start date must be a date like 2026-11-20.')).toBeVisible();
  await expect(page.getByLabel('From date, UTC')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('link', { name: 'Export CSV' })).toHaveCount(0);
  await shot(page, 'audit-log-error');
  await page.goto('/app/audit-log?from=2026-11-20&to=2026-11-01');
  await expect(page.getByText('The end date is before the start date.')).toBeVisible();
  w.expectClean(['response 422', 'status of 422']);
});

test('pages through older entries', async ({ page }) => {
  const w = watch(page);
  await writeEntries(page, 30);
  await page.goto('/app/audit-log');
  await expect(page.getByText('Newest entries: 50 entries shown')).toBeVisible();
  const older = page.getByRole('link', { name: 'Load older entries' });
  await expect(older).toBeVisible();
  await shot(page, 'audit-log-paged');
  await older.click();
  await expect(page).toHaveURL(/before=/);
  await expect(page.getByText(/^Older entries:/)).toBeVisible();
  // Reloading the older page keeps its place, and the way back works.
  await page.reload();
  await expect(page.getByText(/^Older entries:/)).toBeVisible();
  await page.getByRole('link', { name: 'Back to newest' }).click();
  await expect(page.getByText(/^Newest entries:/)).toBeVisible();
  w.expectClean();
});

test('exports a CSV and records that it did', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/audit-log?q=Links');
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^audit-log-\d{4}-\d{2}-\d{2}\.csv$/);
  const path = await file.path();
  const text = (await import('node:fs')).readFileSync(path, 'utf8');
  expect(text).toContain('Links');
  await page.goto('/app/audit-log?action=audit.exported');
  await expect(page.getByText(/Exported \d+ audit log entr/).first()).toBeVisible();
  w.expectClean(['ERR_ABORTED']);
});

test('the owner keeps entries for a chosen time, and can look at the whole install', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/audit-log');
  await page.getByText('90 days', { exact: true }).click();
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Entries older than 90 days are deleted each night.')).toBeVisible();
  await expect(page.getByRole('radio', { name: '90 days' })).toBeChecked();
  await page.getByText('Forever', { exact: true }).click();
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect(page.getByText('Entries are kept forever.')).toBeVisible();

  await page.getByLabel('Which entries').selectOption('all');
  await page.getByRole('button', { name: 'Apply' }).click();
  await expect(page).toHaveURL(/scope=all/);
  await expect(page.getByLabel('Which entries')).toHaveValue('all');
  await expect(page.getByRole('table', { name: 'Audit log entries, newest first' }).getByRole('row').nth(1)).toBeVisible();
  // Entries that belong to no workspace (sign-ins) only show here.
  await page.goto('/app/audit-log?scope=all&q=sign');
  await expect(page.getByRole('table', { name: 'Audit log entries, newest first' }).getByRole('row').nth(1)).toBeVisible();
  await shot(page, 'audit-log-install');
  w.expectClean();
});

test('the page holds at 375 px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of ['/app/audit-log', '/app/audit-log?q=Links', '/app/audit-log?from=bad']) {
    await page.goto(path);
    await expectNoSideScroll(page);
  }
});
