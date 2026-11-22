import { expect, test, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner walks the whole Links product through the real pages, and a visitor in a second browser
// context follows the short link and opens the bio page. Tests run in order and share one database.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState, permissions: ['clipboard-read', 'clipboard-write'] });

// Only public addresses are allowed as destinations. The visitor's browser is sent on to example.com,
// and the test only waits for that request, so it does not matter whether the machine is online.
const DEST = 'https://example.com/landing';
async function visitorPage(browser: Browser) {
  return (await browser.newContext({ baseURL })).newPage();
}
/** Open an address as a visitor and wait until the browser asks for where it redirects to. */
async function followTo(visitor: Page, from: string | (() => Promise<unknown>), to: string) {
  const hop = visitor.waitForRequest((r) => r.url() === to);
  if (typeof from === 'string') visitor.goto(from).catch(() => undefined);
  else from().catch(() => undefined);
  await hop;
}
let shortUrl = '';

test('turns on, shows the first-run screen, and refuses a bad address by the field', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'links');
  await page.goto('/app/links');
  await expect(page.getByRole('heading', { name: 'Shorten your first link' })).toBeVisible();
  await expect(page.getByText('No links yet')).toBeVisible();
  await shoot(page, 'links', 'first-run');

  // The browser would stop a bad address first; switch that off to see the server's own message.
  await page.goto('/app/links/new');
  await page.locator('form.lk-form-page').evaluate((f: { noValidate: boolean }) => { f.noValidate = true; });
  await page.getByLabel('Destination address').fill('not a web address');
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Some fields need fixing' })).toBeVisible();
  await expect(page.locator('#f-url-error')).toContainText(/address|http/i);
  await shoot(page, 'links', 'new-error');
  expect(w.problems).toEqual([]);
});

test('shortens an address from the box and shows the ready card with its QR code', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links');
  await page.getByLabel('Destination address').fill(DEST);
  await page.getByRole('button', { name: 'Shorten' }).click();
  await expect(page.getByRole('heading', { name: 'Your short link is ready' })).toBeVisible();
  shortUrl = (await page.locator('#ready code').first().innerText()).trim();
  expect(shortUrl).toMatch(new RegExp(`^${baseURL}/[a-z0-9]{7}$`));
  const qr = page.getByRole('img', { name: /QR code for/ });
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((i: { naturalWidth: number }) => i.naturalWidth)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Copy short link', exact: true }).click();
  await expect(page.getByText('Short link copied.')).toBeVisible();
  await shoot(page, 'links', 'ready');

  // The PNG button is drawn by links.js in the browser.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download QR as PNG' }).click();
  expect((await download).suggestedFilename()).toMatch(/-qr\.png$/);
  expect(w.problems).toEqual([]);
});

test('a visitor follows the short link and the click shows in the stats', async ({ page, browser }) => {
  const visitor = await visitorPage(browser);
  const res = await visitor.request.get(shortUrl, { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers().location).toBe(DEST);
  await followTo(visitor, shortUrl, DEST);
  await visitor.context().close();

  await expect
    .poll(async () => {
      await page.goto('/app/links');
      return (await page.locator('tbody tr').first().locator('td').nth(2).innerText()).trim();
    }, { timeout: 15_000 })
    .not.toBe('0');
  const w = watch(page);
  await page.goto('/app/links/stats');
  await expect(page.getByRole('heading', { name: 'Stats', exact: true })).toBeVisible();
  await expect(page.getByText('Clicks', { exact: true }).first()).toBeVisible();
  await shoot(page, 'links', 'stats');
  expect(w.problems).toEqual([]);
});

test('makes a link in the full form, and a taken code is refused next to the code field', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links/new');
  await page.getByLabel('Destination address').fill(`${DEST}?from=spring`);
  await page.locator('#f-code').fill('spring');
  await page.locator('#f-title').fill('Spring sale');
  await page.locator('#f-utmSource').fill('newsletter');
  await page.locator('#f-tg').fill('launch, email');
  await shoot(page, 'links', 'new-filled');
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('heading', { name: 'Your short link is ready' })).toBeVisible();

  await page.goto('/app/links/new');
  await page.getByLabel('Destination address').fill(DEST);
  await page.locator('#f-code').fill('spring');
  await page.getByRole('button', { name: 'Create link' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Some fields need fixing' })).toBeVisible();
  await expect(page.locator('#f-code-error')).toContainText(/taken|already|use/i);
  expect(w.problems).toEqual([]);
});

test('searches, filters, tags and archives from the list, and restores', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByLabel('Search links').fill('spring');
  await page.getByLabel('Search links').press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Spring sale' })).toBeVisible();
  await page.getByLabel('Search links').fill('zzzz-nothing');
  await page.getByLabel('Search links').press('Enter');
  await expect(page.getByText('No links match')).toBeVisible();
  await page.getByRole('link', { name: 'Clear filters' }).click();

  await page.getByLabel('Select Spring sale').check();
  await page.getByLabel('Tag to add').fill('seasonal');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByText('Tagged 1 link.')).toBeVisible();

  await page.getByLabel('Select all links on this page').check();
  await page.getByRole('button', { name: 'Archive', exact: true }).click();
  await expect(page.getByText('Archived 2 links.')).toBeVisible();
  await page.getByLabel('Status').selectOption('archived');
  await page.getByLabel('Status').press('Enter');
  await page.goto('/app/links?status=archived');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await shoot(page, 'links', 'archived');
  await page.getByLabel('Select all links on this page').check();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(page.getByText('Restored 2 links.')).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('edits a link, rejects a bad change, and previews and downloads the QR code', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links');
  await page.getByRole('link', { name: 'Spring sale' }).click();
  await expect(page.locator('#f-title')).toHaveValue('Spring sale');
  await page.locator('#f-title').fill('Spring sale 2027');
  await page.locator('#f-cap').fill('500');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.locator('#f-cap')).toHaveValue('500');
  await shoot(page, 'links', 'editor');

  await page.locator('#f-url').fill('nope');
  await page.locator('form#link-form').evaluate((f: { noValidate: boolean }) => { f.noValidate = true; });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Some fields need fixing' })).toBeVisible();
  await expect(page.locator('#f-url')).toHaveAttribute('aria-invalid', 'true');

  await page.goto('/app/links');
  await page.getByRole('link', { name: 'Spring sale 2027' }).click();
  await page.getByLabel('Dots colour').fill('#1d4ed8');
  await page.getByLabel('Margin').fill('4');
  await page.getByRole('button', { name: 'Update preview' }).click();
  await expect(page).toHaveURL(/qr_fg=%231d4ed8/);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PNG' }).click();
  expect((await download).suggestedFilename()).toMatch(/-qr\.png$/);
  expect(w.problems).toEqual([]);
});

test('duplicates from the row menu, then deletes with the confirm dialog', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links');
  await page.getByRole('button', { name: 'More actions for spring' }).click();
  await page.getByRole('menuitem', { name: 'Duplicate' }).click();
  await expect(page.getByText(/^Duplicated\. The copy is \//)).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await shoot(page, 'links', 'delete-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete link' }).click();
  await expect(page.getByText(/^Deleted \//)).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('builds a bio page, a visitor opens it and clicks a block', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto('/app/links/bio');
  await expect(page.getByText('No bio pages yet')).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Olive at the shed');
  await page.getByLabel('Address').fill('olive-shed');
  await page.getByRole('button', { name: 'Create' }).click();
  await expect(page.getByText('Bio page created.')).toBeVisible();

  const add = async (kind: string, fields: Record<string, string>) => {
    const form = page.locator('form.lk-add');
    await form.getByLabel('Type').selectOption(kind);
    for (const [id, value] of Object.entries(fields)) await form.locator(`#n-${id}`).fill(value);
    await form.getByRole('button', { name: 'Add block' }).click();
    await expect(page.getByText('Block added.')).toBeVisible();
  };
  await add('heading', { title: 'Find me here' });
  await add('link', { title: 'The health page', url: DEST });
  await add('text', { body: 'Open every weekday.' });
  await expect(page.locator('li.lk-block')).toHaveCount(3);

  await page.getByLabel('Name', { exact: true }).first().fill('Olive at the shed');
  await page.getByLabel('Published: anyone with the address can see it').check();
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await shoot(page, 'links', 'bio-editor');

  // Order: move the link block up, and see it first.
  await page.getByRole('button', { name: 'Move The health page up' }).click();
  await expect(page.locator('li.lk-block').first().locator('input[name="title"]')).toHaveValue('The health page');

  const visitor = await visitorPage(browser);
  const vw = watch(visitor);
  await visitor.goto('/olive-shed');
  await expect(visitor.getByRole('heading', { name: 'Olive at the shed' })).toBeVisible();
  await expect(visitor.getByText('Open every weekday.')).toBeVisible();
  await shoot(visitor, 'links', 'bio-public');
  await followTo(visitor, () => visitor.getByRole('link', { name: 'The health page' }).click(), DEST);
  expect(vw.problems).toEqual([]);
  await visitor.context().close();

  await page.reload();
  await expect(page.locator('li.lk-block').first()).toContainText('1 clicks in 30 days');

  await page.getByRole('button', { name: 'Remove', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Block removed.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page' }).click();
  await expect(page.getByText('Bio page deleted.')).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('settings: folder, blocked domain, defaults; import and export', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/links/settings');
  await page.getByLabel('Folder name').first().fill('Campaigns');
  await page.getByRole('button', { name: 'Add folder' }).click();
  await expect(page.getByText('Folder added.')).toBeVisible();
  await page.getByLabel('Domain to block').fill('bad.example.net');
  await page.getByRole('button', { name: 'Block domain' }).click();
  await expect(page.getByText('bad.example.net is blocked.')).toBeVisible();
  await page.getByLabel('Random code length').fill('9');
  await page.getByRole('button', { name: 'Save defaults' }).click();
  await expect(page.getByText('Defaults saved.')).toBeVisible();
  await shoot(page, 'links', 'settings');
  await page.getByRole('button', { name: 'Unblock bad.example.net' }).click();
  await expect(page.getByText('Domain unblocked.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete folder' }).click();
  await expect(page.getByText('Folder deleted.')).toBeVisible();

  await page.goto('/app/links/import');
  await page.getByRole('button', { name: 'Read the file' }).click();
  const csv = 'url,title\nhttps://example.com/one,One\nnot-an-address,Broken\n';
  await page.getByLabel('CSV file').setInputFiles({ name: 'links.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('heading', { name: 'Check the columns' })).toBeVisible();
  await shoot(page, 'links', 'import-map');
  await page.getByRole('button', { name: /^Import 2 links/ }).click();
  await expect(page.getByRole('heading', { name: 'Import finished' })).toBeVisible();
  await expect(page.getByText('1 links created, 1 skipped.')).toBeVisible();
  await shoot(page, 'links', 'import-done');

  await page.goto('/app/links/import');
  const exported = await page.request.get('/app/links/export/links.csv');
  expect(exported.status()).toBe(200);
  expect(await exported.text()).toContain('example.com/one');
  await expectNoSideScroll(page);
  expect(w.problems).toEqual([]);
});
