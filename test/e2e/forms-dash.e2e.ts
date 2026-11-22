/**
 * Forms, signed in as the owner: turn it on, build a form in the builder, publish it, answer it as
 * a visitor in a second browser context, then work the responses, settings, import and trash.
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

let formId = '';
const SLUG = 'shed-hello';

async function visitorPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ baseURL });
  return context.newPage();
}

/** The builder saves a moment after each change. */
const saved = (page: Page) => expect(page.locator('#fb-status')).toHaveText('All changes saved');

/** Adds a block of the given kind to the first page and sets its question. */
async function addBlock(page: Page, type: string, question: string, required = false): Promise<void> {
  await page.getByLabel('Add a block to this page').first().selectOption(type);
  const inspector = page.locator('#fb-inspector');
  await inspector.getByLabel('Question').fill(question);
  if (required) await inspector.getByLabel('Required').check();
}

test('turns on, shows the first-run screen, and starts a blank form in the builder', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'forms');
  await page.goto('/app/forms');
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();
  await expect(page.getByText('Add two sample forms')).toBeVisible();
  await shoot(page, 'forms', 'first-run');

  await page.getByRole('button', { name: 'Add sample forms' }).click();
  await expect(page.getByText('Sample forms added.')).toBeVisible();
  await expect(page.getByText('Sample forms are on')).toBeVisible();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await shoot(page, 'forms', 'sample');
  await page.getByRole('button', { name: 'Remove sample forms' }).click();
  await expect(page.getByText('Sample forms removed.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Start from a template' })).toBeVisible();

  await page.locator('#first-blank').click();
  await expect(page).toHaveURL(/\/app\/forms\/frm_[a-z0-9]+\/edit$/);
  formId = page.url().split('/')[5]!;
  await expect(page.getByText('This page has no blocks yet')).toBeVisible();
  await shoot(page, 'forms', 'builder-empty');
  expect(w.problems).toEqual([]);
});

test('builds the form: blocks, edits, undo and redo, moving, and the form settings tab', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/edit`);
  await addBlock(page, 'short_text', 'Your name', true);
  await addBlock(page, 'email', 'Email address', true);
  await addBlock(page, 'long_text', 'What can we help with?');
  await addBlock(page, 'rating', 'How is the shed?');
  await expect(page.locator('.fb-block')).toHaveCount(4);
  await expect(page.locator('.fb-block').first()).toContainText('Your name');
  await expect(page.locator('.fb-block').first()).toContainText('Required');

  // Undo first takes back the typed question, then the block itself. Redo puts both back.
  await page.locator('#fb-undo').click();
  await expect(page.locator('.fb-block').last()).not.toContainText('How is the shed?');
  await page.locator('#fb-undo').click();
  await expect(page.locator('.fb-block')).toHaveCount(3);
  await page.locator('#fb-redo').click();
  await page.locator('#fb-redo').click();
  await expect(page.locator('.fb-block')).toHaveCount(4);
  await expect(page.locator('.fb-block').last()).toContainText('How is the shed?');

  // Move the rating up with the buttons, then back down with the keyboard.
  await page.getByRole('button', { name: 'Move up: How is the shed?' }).click();
  await expect(page.locator('.fb-block').nth(2)).toContainText('How is the shed?');
  await page.locator('.fb-block').nth(2).locator('.fb-pick').focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.locator('.fb-block').nth(3)).toContainText('How is the shed?');

  // Duplicate and remove.
  await page.getByRole('button', { name: 'Duplicate: Your name' }).click();
  await expect(page.locator('.fb-block')).toHaveCount(5);
  await page.getByRole('button', { name: /^Remove: / }).nth(1).click();
  await expect(page.locator('.fb-block')).toHaveCount(4);

  await page.locator('#fb-tab-endings').click();
  await page.locator('#fb-inspector').getByLabel('Title', { exact: true }).fill('Thanks, shed friend');
  await page.locator('#fb-tab-form').click();
  await page.locator('#fb-inspector').getByLabel('Submit button label').fill('Send it');
  await saved(page);
  await shoot(page, 'forms', 'builder');

  // On a phone the block rows wrap, so the buttons never sit on top of the question text.
  await page.setViewportSize({ width: 375, height: 800 });
  const first = page.locator('.fb-block').first();
  const pick = await first.locator('.fb-pick').boundingBox();
  const tools = await first.locator('.fb-tools').boundingBox();
  if (!pick || !tools) throw new Error('block row has no boxes');
  expect(pick.y + pick.height <= tools.y + 1 || pick.x + pick.width <= tools.x + 1).toBe(true);
  await page.setViewportSize({ width: 1280, height: 800 });

  // It all survives a reload.
  await page.reload();
  await expect(page.locator('.fb-block')).toHaveCount(4);
  await expect(page.locator('#fb-live')).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('history lists saved versions, and the address is set before publishing', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/settings`);
  await page.getByLabel('Name', { exact: true }).fill('Shed hello');
  await page.getByLabel('Address', { exact: true }).fill(SLUG);
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByLabel('Address', { exact: true })).toHaveValue(SLUG);

  await page.goto(`/app/forms/${formId}/edit`);
  await page.getByRole('button', { name: 'History' }).click();
  await expect(page.getByRole('dialog', { name: 'Version history' })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).first().click();

  await page.locator('#fb-publish').click();
  await expect(page.locator('#fb-status')).toHaveText('Published');
  await expect(page.getByRole('link', { name: 'Share' })).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('a visitor sees errors by the fields, then submits and sees the thank you', async ({ browser }) => {
  const visitor = await visitorPage(browser);
  const w = watch(visitor);
  await visitor.goto(`/f/${SLUG}`);
  await expect(visitor.getByRole('heading', { name: 'Shed hello' })).toBeVisible();

  await visitor.getByRole('button', { name: 'Send it' }).click();
  await expect(visitor.getByText('Some answers need another look.')).toBeVisible();
  await expect(visitor.getByRole('textbox', { name: 'Your name' })).toHaveAttribute('aria-invalid', 'true');
  await expect(visitor.locator('.pub-error').filter({ hasText: 'This question needs an answer.' }).first()).toBeVisible();
  await shoot(visitor, 'forms', 'public-errors');

  await visitor.getByLabel('Your name').fill('Vera Visitor');
  await visitor.getByLabel('Email address').fill('vera@example.com');
  await visitor.getByLabel('Email address').fill('not an email');
  await visitor.getByRole('button', { name: 'Send it' }).click();
  await expect(visitor.getByRole('textbox', { name: 'Email address' })).toHaveAttribute('aria-invalid', 'true');

  await visitor.getByLabel('Email address').fill('vera@example.com');
  await visitor.getByLabel('What can we help with?').fill('A taller door, please.');
  await visitor.getByRole('radio', { name: '4' }).first().check({ force: true }).catch(async () => visitor.getByText('4', { exact: true }).first().click());
  await shoot(visitor, 'forms', 'public-filled');
  // Answers sent faster than a person could type them are filed as spam, so take a human pace.
  await visitor.waitForTimeout(3500);
  await visitor.getByRole('button', { name: 'Send it' }).click();
  await expect(visitor.getByRole('heading', { name: 'Thanks, shed friend' })).toBeVisible();
  await shoot(visitor, 'forms', 'public-thanks');
  expect(w.problems).toEqual([]);
  await expectNoSideScroll(visitor);
  await visitor.context().close();
});

test('the response shows up for the owner: list, one response, star, note, summary', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/responses`);
  await expect(page.getByRole('row', { name: /vera@example\.com/ }).getByRole('link').first()).toBeVisible();
  await shoot(page, 'forms', 'responses');
  await page.getByRole('row', { name: /vera@example\.com/ }).getByRole('link').first().click();
  await expect(page.getByText('A taller door, please.')).toBeVisible();

  await page.getByRole('button', { name: 'Star', exact: true }).click();
  await expect(page.getByText('Starred.')).toBeVisible();
  await page.getByLabel('Add a note').fill('Call back on Monday');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Note saved.')).toBeVisible();
  await expect(page.getByText('Call back on Monday')).toBeVisible();
  await page.getByLabel('Add a note').fill('');
  await shoot(page, 'forms', 'response');

  await page.goto(`/app/forms/${formId}/responses?starred=1`);
  await expect(page.getByRole('row', { name: /vera@example\.com/ }).getByRole('link').first()).toBeVisible();

  await page.goto(`/app/forms/${formId}/summary`);
  await expect(page.getByRole('heading', { name: 'Nothing to show yet' })).toBeHidden();
  await shoot(page, 'forms', 'summary');
  expect(w.problems).toEqual([]);
});

test('share page, settings validation by the field, and the other settings screens', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/share`);
  await expect(page.getByRole('textbox', { name: 'Form link' })).toHaveValue(new RegExp(`/f/${SLUG}$`));
  await shoot(page, 'forms', 'share');

  await page.goto(`/app/forms/${formId}/settings`);
  await page.getByLabel('Address', { exact: true }).fill('Not A Good Address!');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Use 3 to 60 lower case letters' })).toBeVisible();
  await expect(page.locator('#s-slug')).toHaveAttribute('maxlength', '60');
  await expect(page.locator('#s-slug')).toHaveAttribute('aria-invalid', 'true');
  await page.goto(`/app/forms/${formId}/settings`);
  await page.getByLabel('Response limit').fill('50');
  await page.getByLabel('Message when closed').fill('The shed is closed.');
  await page.getByLabel('Style').selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByLabel('Response limit')).toHaveValue('50');
  await shoot(page, 'forms', 'settings');

  await page.goto('/app/forms/privacy');
  await page.getByLabel('Respondent email').fill('vera@example.com');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.getByText('vera@example.com').first()).toBeVisible();
  await shoot(page, 'forms', 'privacy');
  expect(w.problems).toEqual([]);
});

test('closes and reopens the form, and the visitor sees it closed', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/share`);
  await page.getByRole('button', { name: 'Close the form' }).click();
  await expect(page.getByRole('button', { name: /Reopen/ })).toBeVisible();

  const visitor = await visitorPage(browser);
  await visitor.goto(`/f/${SLUG}`);
  await expect(visitor.getByText('The shed is closed.')).toBeVisible();
  await visitor.context().close();

  await page.getByRole('button', { name: /Reopen/ }).click();
  await expect(page.getByRole('button', { name: 'Close the form' })).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('imports responses from pasted CSV with the columns matched', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/forms/${formId}/import`);
  await page.getByLabel('Or paste the CSV').fill('Name,Mail,Message\nIvy Import,ivy@example.com,From a spreadsheet');
  await page.getByRole('button', { name: 'Continue' }).click();
  await shoot(page, 'forms', 'import-map');
  const selects = page.locator('select[name^="map_"]');
  await expect(selects).toHaveCount(3);
  await selects.nth(0).selectOption({ label: 'Your name' });
  await selects.nth(1).selectOption({ label: 'Email address' });
  await selects.nth(2).selectOption({ label: 'What can we help with?' });
  await page.getByRole('button', { name: /^Import/ }).click();
  await expect(page.getByText('Imported 1 response.')).toBeVisible();
  await expect(page.getByRole('row', { name: /ivy@example\.com/ })).toBeVisible();

  await page.goto(`/app/forms/${formId}/import`);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Choose a CSV file or paste its contents.')).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('duplicates, searches, trashes with the confirm dialog, restores and deletes for good', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/forms');
  await page.getByRole('button', { name: 'Duplicate' }).first().click();
  await expect(page.locator('tbody tr')).toHaveCount(2);

  await page.getByLabel('Search forms').fill('zzz-nothing');
  await page.getByRole('button', { name: 'Apply' }).click().catch(() => page.getByLabel('Search forms').press('Enter'));
  await expect(page.getByText('No forms match')).toBeVisible();
  await page.goto('/app/forms?status=draft');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.goto('/app/forms');

  await page.getByRole('button', { name: 'Trash' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Trash' }).first().click();
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await shoot(page, 'forms', 'list');

  await page.goto('/app/forms?view=trash');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Restore' }).click();
  await page.goto('/app/forms?view=trash');
  await expect(page.getByText('The trash is empty')).toBeVisible();
  await page.goto('/app/forms');
  await page.getByRole('button', { name: 'Trash' }).first().click();
  await dialog.getByRole('button', { name: 'Move to trash' }).click();
  await page.goto('/app/forms?view=trash');
  await page.getByRole('button', { name: 'Delete' }).first().click();
  await dialog.getByRole('button', { name: 'Delete for good' }).click();
  await expect(page.getByText('The trash is empty')).toBeVisible();
  expect(w.problems).toEqual([]);
});
