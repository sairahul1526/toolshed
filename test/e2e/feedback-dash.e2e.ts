import { expect, test, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { disableModule, enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner sets up a feedback portal through the real pages, visitors in other browser contexts use it,
// and the owner then works the inbox, roadmap, changelog, settings and data screens. Tests run in
// order and share one database.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

const SLUG = 'shed-ideas';
const APP = '/app/feedback';

async function visitorPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL })).newPage();
}

test('turns on, shows the first-run steps, and creates the portal', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'feedback');
  await page.goto(APP);
  await expect(page.getByText('Name your portal')).toBeVisible();
  await expect(page.getByText('Not seen yet').first()).toBeHidden();
  await shoot(page, 'feedback', 'first-run');

  // The name is required, and the browser says so before anything is sent.
  await page.getByRole('button', { name: 'Create portal' }).click();
  await expect(page).toHaveURL(new RegExp(`${APP}$`));
  await expect(page.locator('#s-name:invalid')).toHaveCount(1);

  await page.locator('#s-name').fill('Shed ideas');
  await page.getByRole('button', { name: 'Create portal' }).click();
  await expect(page.getByText('Portal created.')).toBeVisible();
  await expect(page.getByText(`/feedback/${SLUG}`).first()).toBeVisible();
  await expect(page.getByText('Not seen yet')).toBeVisible();
  const done = await page.locator('.pill', { hasText: 'Done' }).first().boundingBox();
  expect(done?.width ?? 999).toBeLessThan(200);
  await shoot(page, 'feedback', 'empty-inbox');
  expect(w.problems).toEqual([]);
});

test('sample data fills the inbox and clears again', async ({ page }) => {
  const w = watch(page);
  await page.goto(APP);
  await page.getByRole('button', { name: 'Fill with sample data' }).click();
  await expect(page.getByText('Sample data added.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear sample data' })).toBeVisible();
  await shoot(page, 'feedback', 'inbox-sample');

  await page.getByRole('button', { name: 'Clear sample data' }).click();
  await expect(page.getByText('Sample data cleared.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No posts yet' })).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('general settings save, show errors by the field, and change the public portal', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`${APP}/settings/general`);
  await expect(page.getByText('Email is ready')).toBeVisible();

  await page.locator('#g-accent').fill('purple');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#g-accent')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'feedback', 'settings-general-error');
  await page.locator('#g-accent').fill('');
  await page.locator('#g-slug').fill('Not A Slug!');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#g-slug')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#g-name').fill('Shed feedback');
  await page.locator('#g-slug').fill(SLUG);
  await page.locator('#g-tag').fill('Tell us what to build next.');
  await page.locator('#g-theme').selectOption('Dusk');
  await page.locator('#g-accent').fill('#3f6212');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await expect(page.locator('#g-name')).toHaveValue('Shed feedback');
  await shoot(page, 'feedback', 'settings-general');

  const visitor = await visitorPage(browser);
  await visitor.goto(`/feedback/${SLUG}`);
  await expect(visitor.getByText('Shed feedback').first()).toBeVisible();
  await expect(visitor.getByText('Tell us what to build next.')).toBeVisible();
  await visitor.context().close();
  expect(w.problems).toEqual([]);
});

test('boards, categories, statuses and tags are added, edited, ordered and removed', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${APP}/settings/boards`);
  await page.locator('#nb-name').fill('Bugs');
  await page.getByRole('button', { name: 'Add board' }).click();
  await expect(page.getByText('Board added.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bugs' })).toBeVisible();

  const bugs = page.locator('section, .card', { has: page.getByRole('heading', { name: 'Bugs' }) }).last();
  await bugs.getByRole('textbox', { name: 'New category' }).fill('Billing');
  await bugs.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Billing')).toBeVisible();
  await shoot(page, 'feedback', 'settings-boards');

  await bugs.getByLabel('Description').fill('Things that are broken.');
  await bugs.getByRole('button', { name: 'Save board' }).click();
  await expect(page.getByText('Board saved.')).toBeVisible();
  await expect(page.locator('input[value="Things that are broken."]')).toHaveCount(1);

  await page.goto(`${APP}/settings/statuses`);
  await page.locator('#ns-name').fill('Shipped soon');
  await page.locator('#ns-kind').selectOption('Active');
  await page.getByRole('button', { name: 'Add status' }).click();
  await expect(page.getByText('Status added.')).toBeVisible();
  await expect(page.locator('td input[value="Shipped soon"]')).toBeVisible();
  await shoot(page, 'feedback', 'settings-statuses');
  await page.getByRole('button', { name: 'Move Shipped soon up' }).click();
  await expect(page.getByRole('button', { name: 'Move Shipped soon down' })).toBeVisible();

  await page.goto(`${APP}/settings/tags`);
  await page.locator('#nt-name').fill('Billing');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByText('Tag added.')).toBeVisible();
  await shoot(page, 'feedback', 'settings-tags');
  expect(w.problems).toEqual([]);
});

let postUrl = '';

test('the owner posts for a customer, and a visitor sees it, votes and comments', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`${APP}/posts/new`);
  await page.locator('#np-title').fill('Dark mode for the dashboard');
  // Looks fine to the browser, but there is no dot in the domain.
  await page.locator('#np-email').fill('ada@localhost');
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.locator('#np-email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#np-title')).toHaveValue('Dark mode for the dashboard');
  await shoot(page, 'feedback', 'new-post-error');

  await page.locator('#np-details').fill('Please add a dark theme for night shifts.');
  await page.locator('#np-email').fill('ada@example.com');
  await page.locator('#np-name').fill('Ada Lovelace');
  await page.getByRole('button', { name: 'Publish post' }).click();
  await expect(page.getByText('Post published.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dark mode for the dashboard' })).toBeVisible();
  postUrl = page.url();
  await expect(page.getByText('Added by your team')).toBeVisible();
  await shoot(page, 'feedback', 'post');

  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/feedback/${SLUG}`);
  await expect(visitor.getByRole('link', { name: 'Dark mode for the dashboard' })).toBeVisible();
  await shoot(visitor, 'feedback', 'public-portal');
  await visitor.getByRole('link', { name: 'Dark mode for the dashboard' }).click();
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('Dark mode for the dashboard');
  await shoot(visitor, 'feedback', 'public-post');
  expect(v.problems).toEqual([]);
  await visitor.context().close();
  expect(w.problems).toEqual([]);
});

/** The six digit code from the sign-in email. */
async function codeFor(visitor: Page, to: string): Promise<string> {
  let code = '';
  await expect
    .poll(async () => {
      const res = await visitor.request.get(`/dev/outbox?to=${encodeURIComponent(to)}`);
      const mails = ((await res.json()) as { emails: { text: string }[] }).emails;
      code = mails.map((m) => m.text.match(/\b(\d{6})\b/)?.[1] ?? '').find(Boolean) ?? '';
      return code;
    })
    .not.toBe('');
  return code;
}

test('a visitor signs in with an emailed code, votes, comments and shares an idea', async ({ browser }) => {
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/feedback/${SLUG}/sign-in`);
  await expect(visitor.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await visitor.getByLabel('Email').fill('grace@example.com');
  await visitor.getByLabel(/^Your name/).fill('Grace Hopper');
  await visitor.getByRole('button', { name: 'Send code' }).click();
  await expect(visitor.getByText('We sent a code to')).toBeVisible();

  await visitor.getByLabel('Six digit code').fill('000000');
  await visitor.getByRole('button', { name: 'Confirm and sign in' }).click();
  await expect(visitor.getByLabel('Six digit code')).toHaveAttribute('aria-invalid', 'true');
  await shoot(visitor, 'feedback', 'public-sign-in-error');

  await visitor.getByLabel('Six digit code').fill(await codeFor(visitor, 'grace@example.com'));
  await visitor.getByRole('button', { name: 'Confirm and sign in' }).click();
  await expect(visitor).toHaveURL(new RegExp(`/feedback/${SLUG}`));

  await visitor.getByRole('link', { name: 'Dark mode for the dashboard' }).click();
  const vote = visitor.getByRole('button', { name: /Vote for Dark mode/ });
  await vote.click();
  await expect(visitor.getByRole('button', { name: /Remove your vote from Dark mode/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(visitor.locator('[data-count]').first()).toHaveText('2');
  await visitor.reload();
  await expect(visitor.locator('[data-count]').first()).toHaveText('2');

  await visitor.getByLabel('Add a comment').fill('I would use this every night.');
  await visitor.waitForTimeout(2800);
  await visitor.getByRole('button', { name: 'Post comment' }).click();
  await expect(visitor.getByText('I would use this every night.')).toBeVisible();
  await shoot(visitor, 'feedback', 'public-post-voted');

  await visitor.goto(`/feedback/${SLUG}/new`);
  await visitor.getByRole('button', { name: 'Post idea' }).click();
  await expect(visitor.locator('#title:invalid')).toHaveCount(1);
  await visitor.locator('#title').fill('Export everything to CSV');
  await visitor.locator('#details').fill('We need a full export of every post.');
  await visitor.waitForTimeout(2800);
  await visitor.getByRole('button', { name: 'Post idea' }).click();
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('Export everything to CSV');
  await shoot(visitor, 'feedback', 'public-new-post-done');
  expect(v.problems).toEqual([]);
  await visitor.context().close();
});

async function guestIdea(visitor: Page, title: string): Promise<void> {
  await visitor.goto(`/feedback/${SLUG}/new`);
  await visitor.locator('#title').fill(title);
  await visitor.locator('#details').fill('Posted without signing in.');
  await visitor.waitForTimeout(2800);
  await visitor.getByRole('button', { name: 'Post idea' }).click();
}

test('guest ideas wait in the inbox until the owner approves or rejects them', async ({ page, browser }) => {
  const w = watch(page);
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await guestIdea(visitor, 'Guest idea to approve');
  await expect(visitor.getByText(/An admin will look at it before it appears/)).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Guest idea to approve' })).toHaveCount(0);
  await shoot(visitor, 'feedback', 'public-held');
  await guestIdea(visitor, 'Guest idea to reject');
  await expect(visitor.getByText(/An admin will look at it before it appears/)).toBeVisible();

  await page.goto(`${APP}?view=review`);
  await expect(page.getByRole('link', { name: 'Guest idea to approve' })).toBeVisible();
  await shoot(page, 'feedback', 'inbox-review');
  const approve = page.getByRole('row', { name: /Guest idea to approve/ }).getByRole('button', { name: 'Approve' });
  await approve.click();
  await expect(page.getByText('Post approved and published.')).toBeVisible();
  await page.getByRole('row', { name: /Guest idea to reject/ }).getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText('Post rejected.')).toBeVisible();

  await visitor.goto(`/feedback/${SLUG}`);
  await expect(visitor.getByRole('link', { name: 'Guest idea to approve' })).toBeVisible();
  await expect(visitor.getByRole('link', { name: 'Guest idea to reject' })).toHaveCount(0);
  expect(v.problems).toEqual([]);
  await visitor.context().close();
  await page.goto(APP);
  await expectNoSideScroll(page);
  await shoot(page, 'feedback', 'inbox');
  expect(w.problems).toEqual([]);
});

test('the owner replies, changes status, tags, adds a vote, merges and deletes a post', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(postUrl);
  await page.getByLabel('Reply as the team').fill('We are on it, thanks for the idea.');
  await page.getByRole('button', { name: 'Post reply' }).click();
  await expect(page.getByText('Reply posted.')).toBeVisible();
  await page.getByLabel('Add a note').fill('Ask design about contrast first.');
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText('Note saved.')).toBeVisible();
  await expect(page.getByText('Ask design about contrast first.')).toBeVisible();

  await page.locator('#st').selectOption({ label: 'Planned' });
  await page.getByRole('button', { name: 'Update status' }).click();
  await expect(page.getByText('Status updated.')).toBeVisible();
  await expect(page.locator('#st')).toHaveValue(/.+/);

  await page.locator('#d-assignee').fill('Sam');
  await page.getByRole('checkbox', { name: 'Billing' }).check();
  await page.getByRole('button', { name: 'Save details' }).click();
  await expect(page.getByText('Details saved.')).toBeVisible();
  await expect(page.locator('#d-assignee')).toHaveValue('Sam');
  await expect(page.getByRole('checkbox', { name: 'Billing' })).toBeChecked();

  await page.getByLabel('Add a vote for a customer').fill('ada@localhost');
  await page.getByRole('button', { name: 'Add vote' }).click();
  await expect(page.getByText(/valid email/i)).toBeVisible();
  await page.getByLabel('Add a vote for a customer').fill('lin@example.com');
  await page.getByRole('button', { name: 'Add vote' }).click();
  await expect(page.getByText('Vote added.')).toBeVisible();
  await expect(page.getByText('lin@example.com')).toBeVisible();
  await shoot(page, 'feedback', 'post-managed');

  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/feedback/${SLUG}`);
  await visitor.getByRole('link', { name: 'Dark mode for the dashboard' }).click();
  await expect(visitor.getByText('We are on it, thanks for the idea.')).toBeVisible();
  await expect(visitor.getByText('Planned').first()).toBeVisible();
  await expect(visitor.getByText('Ask design about contrast first.')).toHaveCount(0);
  await shoot(visitor, 'feedback', 'public-post-managed');
  expect(v.problems).toEqual([]);
  await visitor.context().close();

  await page.goto(`${postUrl}/merge?q=Guest`);
  await expect(page.getByRole('link', { name: 'Preview merge' })).toHaveCount(1);
  await page.goto(`${APP}`);
  await page.getByRole('link', { name: 'Guest idea to approve' }).click();
  await page.getByLabel('Find the post to keep').fill('Dark mode');
  await page.getByRole('button', { name: 'Find posts' }).click();
  await page.getByRole('link', { name: 'Preview merge' }).click();
  await expect(page.getByText('Votes after the merge')).toBeVisible();
  await shoot(page, 'feedback', 'merge-preview');
  await page.getByRole('button', { name: 'Merge posts' }).click();
  await expect(page.getByText('Posts merged.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Dark mode for the dashboard' })).toBeVisible();
  await page.goto(APP);
  await expect(page.getByRole('link', { name: 'Guest idea to approve' })).toHaveCount(0);

  await page.goto(APP);
  await page.getByRole('link', { name: 'Export everything to CSV' }).click();
  await page.getByRole('button', { name: 'Delete post' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete post' }).click();
  await expect(page.getByText('Post deleted.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Export everything to CSV' })).toHaveCount(0);
  expect(w.problems).toEqual([]);
});

test('the owner publishes a changelog entry, visitors read and subscribe, and linked posts complete', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`${APP}/changelog`);
  await expect(page.getByText('No entries yet')).toBeVisible();
  await shoot(page, 'feedback', 'changelog-empty');

  await page.getByRole('link', { name: 'New entry' }).first().click();
  await page.locator('#e-title').fill('Dark mode is here');
  await page.locator('#e-state').selectOption({ label: 'Schedule for later' });
  await page.getByRole('button', { name: /Save entry|Publish|Save/ }).first().click();
  await expect(page.locator('#e-at')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#e-title')).toHaveValue('Dark mode is here');

  await page.locator('#e-body').fill('## What changed\n\nA **dark theme** for every screen.');
  await page.locator('#e-author').fill('The Shed team');
  await page.getByRole('checkbox', { name: 'Dark mode for the dashboard' }).check();
  await page.locator('#e-state').selectOption({ label: 'Publish now' });
  await shoot(page, 'feedback', 'changelog-new');
  await page.getByRole('button', { name: /Save entry|Publish|Save/ }).first().click();
  await expect(page.getByText('Entry published.')).toBeVisible();
  await expectNoSideScroll(page);
  await shoot(page, 'feedback', 'changelog-edit');

  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/changelog/${SLUG}`);
  await expect(visitor.getByRole('heading', { name: 'Dark mode is here' })).toBeVisible();
  await expect(visitor.getByText('A dark theme for every screen.')).toBeVisible();
  await shoot(visitor, 'feedback', 'public-changelog');
  await visitor.getByRole('link', { name: 'Dark mode is here' }).click();
  await expect(visitor.getByRole('heading', { level: 1 })).toContainText('Dark mode is here');
  const feed = await visitor.request.get(`/changelog/${SLUG}/feed.rss`);
  expect(feed.headers()['content-type']).toContain('xml');
  expect(await feed.text()).toContain('Dark mode is here');

  await visitor.goto(`/changelog/${SLUG}/subscribe`);
  await visitor.getByLabel('Email').fill('nobody@localhost');
  await visitor.getByRole('button', { name: 'Subscribe' }).click();
  await expect(visitor.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await shoot(visitor, 'feedback', 'public-subscribe-error');
  await visitor.getByLabel('Email').fill('reader@example.com');
  await visitor.getByLabel('How often').selectOption('weekly');
  await visitor.getByRole('button', { name: 'Subscribe' }).click();
  await expect(visitor).toHaveURL(new RegExp(`/changelog/${SLUG}\\?note=`));
  let confirm = '';
  await expect
    .poll(async () => {
      const res = await visitor.request.get('/dev/outbox?to=reader%40example.com');
      const mails = ((await res.json()) as { emails: { text: string }[] }).emails;
      confirm = mails.map((m) => m.text.match(/https?:\/\/\S+\/confirm\?\S+/)?.[0] ?? '').find(Boolean) ?? '';
      return confirm;
    })
    .not.toBe('');
  await visitor.goto(confirm);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('You are subscribed');

  await visitor.goto(`/feedback/${SLUG}`);
  await visitor.getByRole('link', { name: 'Dark mode for the dashboard' }).click();
  await expect(visitor.getByText('Complete').first()).toBeVisible();
  await visitor.goto(`/roadmap/${SLUG}`);
  await expect(visitor.getByRole('heading', { level: 1 })).toHaveText('Roadmap');
  await expect(visitor.getByText('Dark mode for the dashboard')).toBeVisible();
  await shoot(visitor, 'feedback', 'public-roadmap');
  expect(v.problems).toEqual([]);
  await visitor.context().close();

  await page.goto(`${APP}/subscribers`);
  await expect(page.getByRole('cell', { name: 'reader@example.com' })).toBeVisible();
  await expect(page.getByText('Weekly digest')).toBeVisible();
  await shoot(page, 'feedback', 'subscribers');
  await page.getByRole('button', { name: 'Remove' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('Subscriber removed.')).toBeVisible();

  await page.goto(`${APP}/roadmap`);
  await expect(page.getByText('Dark mode for the dashboard')).toBeVisible();
  await shoot(page, 'feedback', 'roadmap');

  await page.goto(`${APP}/changelog`);
  await page.getByRole('link', { name: 'Dark mode is here' }).click();
  await page.locator('#e-title').fill('Dark mode is live');
  await page.getByRole('button', { name: /Save entry|Publish|Save/ }).first().click();
  await expect(page.getByText('Entry saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete entry' }).click();
  await expect(page.getByText('Entry deleted.')).toBeVisible();
  await expect(page.getByText('No entries yet')).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('people can be trusted and blocked, and boards, statuses and tags are deleted behind a confirm', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${APP}/settings/people`);
  const grace = page.getByRole('row', { name: /grace@example.com/ });
  await expect(grace).toBeVisible();
  await grace.getByRole('button', { name: 'Trust', exact: true }).click();
  await expect(page.getByText('Person trusted.')).toBeVisible();
  await expect(page.getByRole('row', { name: /grace@example.com/ }).getByText('Trusted', { exact: true })).toBeVisible();
  await page.getByRole('row', { name: /grace@example.com/ }).getByRole('button', { name: 'Block' }).click();
  await expect(page.getByText('Person blocked.')).toBeVisible();
  await shoot(page, 'feedback', 'settings-people');
  await page.getByRole('row', { name: /grace@example.com/ }).getByRole('button', { name: 'Unblock' }).click();
  await expect(page.getByText('Person unblocked.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search people' }).fill('lin@');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('row', { name: /lin@example.com/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /grace@example.com/ })).toHaveCount(0);

  await page.goto(`${APP}/settings/tags`);
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete tag' }).click();
  await expect(page.getByText('Tag deleted.')).toBeVisible();

  await page.goto(`${APP}/settings/statuses`);
  const used = page.getByRole('row').filter({ has: page.locator('input[value="Complete"]') });
  await used.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText(/in use|uses it|still use/i).first()).toBeVisible();
  const spare = page.getByRole('row').filter({ has: page.locator('input[value="Shipped soon"]') });
  await spare.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Status deleted.')).toBeVisible();

  await page.goto(`${APP}/settings/boards`);
  const bugs = page.locator('section, .card', { has: page.getByRole('heading', { name: 'Bugs' }) }).last();
  await bugs.getByRole('button', { name: 'Delete board' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete board' }).click();
  await expect(page.getByText('Board deleted.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Bugs' })).toHaveCount(0);
  await expectNoSideScroll(page);
  expect(w.problems).toEqual([]);
});

test('posts import from a CSV, a bad file is refused, and exports download', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${APP}/settings/import-export`);
  await shoot(page, 'feedback', 'settings-import-export');
  await page.locator('#imp-file').setInputFiles({ name: 'empty.csv', mimeType: 'text/csv', buffer: Buffer.from('Title\n') });
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByText('That file has no rows.')).toBeVisible();

  await page.locator('#imp-file').setInputFiles({ name: 'ideas.csv', mimeType: 'text/csv', buffer: Buffer.from('Title,Details,Votes\nImported idea one,First body,3\nImported idea two,Second body,1\n') });
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('heading', { name: 'Match the columns' })).toBeVisible();
  await expect(page.locator('#m-title')).toHaveValue('0');
  await shoot(page, 'feedback', 'import-mapping');
  await page.getByRole('button', { name: 'Import 2 rows' }).click();
  await expect(page.getByText('2 posts imported')).toBeVisible();
  await page.goto(APP);
  await expect(page.getByRole('link', { name: 'Imported idea one' })).toBeVisible();

  const csv = await page.request.get(`${APP}/export.csv`);
  expect(csv.headers()['content-type']).toContain('csv');
  expect(await csv.text()).toContain('Imported idea two');
  const json = await page.request.get(`${APP}/export.json`);
  expect(JSON.stringify(await json.json())).toContain('Imported idea one');

  await page.goto(`${APP}/stats`);
  await expect(page.getByRole('heading', { name: 'Stats' })).toBeVisible();
  await shoot(page, 'feedback', 'stats');
  expect(w.problems).toEqual([]);
});

test('the widget script opens the portal on a customer page and the dashboard shows it connected', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`${APP}/settings/widget`);
  await expect(page.getByText('Not seen yet')).toBeVisible();

  const visitor = await (await browser.newContext({ baseURL, permissions: ['local-network-access'] })).newPage();
  const v = watch(visitor);
  await visitor.route('https://customer.test/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><title>Customer app</title></head><body><h1>Customer app</h1>
        <script src="${baseURL}/m/feedback/widget.js" data-portal="${SLUG}" defer></script></body></html>`,
    }),
  );
  await visitor.goto('https://customer.test/');
  // The widget lives in a closed shadow root, so Playwright cannot query it. Click where the floating button sits.
  await expect(visitor.locator('[data-toolshed-feedback]')).toHaveCount(1);
  const size = visitor.viewportSize()!;
  const frameLoaded = visitor.waitForEvent('framenavigated', (f) => f.url().includes(`/feedback/${SLUG}/embed`));
  await visitor.mouse.click(size.width - 60, size.height - 36);
  const frame = await frameLoaded;
  await expect(frame.getByRole('link', { name: 'Dark mode for the dashboard' })).toBeVisible();
  await visitor.screenshot({ path: '.shots/e2e/feedback/widget-open.png' });
  await visitor.evaluate('window.ToolshedFeedback.close()');
  await visitor.evaluate('window.ToolshedFeedback.open()');
  await expect(frame.getByRole('link', { name: 'Dark mode for the dashboard' })).toBeVisible();
  await visitor.keyboard.press('Escape');

  await page.reload();
  await expect(page.getByText('Widget connected')).toBeVisible();
  await expect(page.getByText(/on customer\.test/)).toBeVisible();
  await shoot(page, 'feedback', 'settings-widget');
  expect(v.problems).toEqual([]);
  await visitor.context().close();
  expect(w.problems).toEqual([]);
});

// Later files (Modules, Overview) expect a workspace with nothing switched on.
test.afterAll(async ({ browser }) => {
  await disableModule(browser, 'feedback');
});
