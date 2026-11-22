import { expect, test, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner builds a waitlist through the real pages, visitors in other browser contexts join it,
// and the owner then works the people, review, launch, stats and data screens. Tests run in order
// and share one database.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

const SLUG = 'shed-launch';
let wlId = '';
let friendLink = '';
let referrer: Page;
let statusUrl = '';

async function visitorPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL })).newPage();
}

/** A signup sent within two seconds of loading the page is treated as a bot, so wait like a person. */
async function join(visitor: Page, email: string, name?: string): Promise<void> {
  await visitor.getByLabel('Email').fill(email);
  if (name) await visitor.getByLabel(/^Name/).fill(name);
  await visitor.waitForTimeout(2300);
  await visitor.getByRole('button', { name: 'Join the waitlist' }).click();
}

async function confirmLinkFor(visitor: Page, to: string): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const res = await visitor.request.get(`/dev/outbox?to=${encodeURIComponent(to)}`);
      const mails = ((await res.json()) as { emails: { text: string }[] }).emails;
      link = mails.map((m) => m.text.match(/https?:\/\/\S+\/confirm\/\S+/)?.[0] ?? '').find(Boolean) ?? '';
      return link;
    })
    .not.toBe('');
  return link.replace(/[).,]+$/, '');
}

/** Join, confirm by email and land on the personal status page. */
async function joinAndConfirm(visitor: Page, from: string, email: string, name?: string): Promise<void> {
  await visitor.goto(from);
  await join(visitor, email, name);
  await expect(visitor.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await visitor.goto(await confirmLinkFor(visitor, email));
  await visitor.getByRole('button').first().click();
  await expect(visitor.getByRole('heading', { name: /You are number/ })).toBeVisible();
}

test('turns on, shows the first-run screen, and creates a waitlist', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'waitlist');
  await page.goto('/app/waitlist');
  await expect(page.getByRole('heading', { name: 'No waitlists yet' })).toBeVisible();
  await shoot(page, 'waitlist', 'first-run');

  await page.getByRole('button', { name: 'Create your first waitlist' }).click();
  // The name is required, and the browser says so before anything is sent.
  await expect(page.getByLabel('Name of your waitlist')).toBeFocused();

  await page.getByLabel('Name of your waitlist').fill('Shed launch');
  await page.getByRole('button', { name: 'Create your first waitlist' }).click();
  await expect(page.getByText('Waitlist created')).toBeVisible();
  wlId = new URL(page.url()).searchParams.get('w') ?? '';
  expect(wlId).not.toBe('');
  await shoot(page, 'waitlist', 'created');
  expect(w.problems).toEqual([]);
});

test('edits the page: errors by the field, then saves, adds a tier and goes live', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/edit?w=${wlId}`);

  await page.getByLabel('Page address').fill('Not A Good Address!');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Some fields need fixing' })).toBeVisible();
  await expect(page.locator('#f-slug')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#f-slug-error')).toBeVisible();
  await shoot(page, 'waitlist', 'editor-error');

  await page.getByLabel('Page address').fill(SLUG);
  await page.getByLabel('Headline').fill('Be first in line');
  await page.getByLabel('Description', { exact: true }).fill('A short note about what we are building.');
  await page.getByLabel('Questions', { exact: true }).fill('What will you use it for? | text | optional');
  await page.getByLabel('Status').selectOption('live');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByLabel('Page address')).toHaveValue(SLUG);

  // A bad question line is refused by the field.
  await page.getByLabel('Questions', { exact: true }).fill('Pick one | select | required');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#f-questions-error')).toBeVisible();
  await page.goto(`/app/waitlist/edit?w=${wlId}`);

  await page.getByLabel('Referrals needed').fill('1');
  await page.getByLabel('Tier name').fill('Early access');
  await page.locator('#tier-reward').fill('Skip the line');
  await page.getByRole('button', { name: 'Add tier' }).click();
  await expect(page.getByText('Tier added.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Reward tiers' })).toContainText('Early access');
  await shoot(page, 'waitlist', 'editor');
  expect(w.problems).toEqual([]);
});

test('a visitor joins, confirms, shares a link and a friend climbs the list', async ({ browser }) => {
  const visitor = await visitorPage(browser);
  referrer = visitor;
  const w = watch(visitor);
  await visitor.goto(`/w/${SLUG}`);
  await expect(visitor.getByRole('heading', { name: 'Be first in line' })).toBeVisible();
  await visitor.getByLabel('Email').fill('sam@localhost');
  await visitor.waitForTimeout(2300);
  await visitor.getByRole('button', { name: 'Join the waitlist' }).click();
  await expect(visitor.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');

  await joinAndConfirm(visitor, `/w/${SLUG}`, 'first@example.com', 'First Person');
  statusUrl = visitor.url();
  friendLink = await visitor.getByLabel('Your link to share').inputValue();
  expect(friendLink).toContain(`/w/${SLUG}?ref=`);

  const friend = await visitorPage(browser);
  await joinAndConfirm(friend, friendLink, 'friend@example.com', 'Fran Friend');
  await friend.context().close();

  // Both browsers share one address, so the balanced rules hold the credit for the owner to look at.
  await visitor.reload();
  await expect(visitor.getByText('1 friend joined with your link.')).toBeHidden();
  await visitor.goto(`/w/${SLUG}/leaderboard`);
  await expect(visitor.getByRole('heading', { name: 'Top referrers' })).toBeVisible();
  expect(w.problems.filter((p) => !p.startsWith('400'))).toEqual([]);
});

test('the held referral credit waits in review, and approving it moves the referrer up', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/review?w=${wlId}`);
  await expect(page.getByRole('table', { name: 'Held for review' })).toContainText('Fran Friend');
  await expect(page.getByRole('table', { name: 'Held for review' })).toContainText('Referral credit');
  await shoot(page, 'waitlist', 'review-credit');
  await page.getByLabel('Select Fran Friend').check();
  await page.getByRole('button', { name: 'Approve selected' }).click();
  await expect(page.getByText('Approved 1 person.')).toBeVisible();

  await referrer.goto(statusUrl);
  await expect(referrer.getByText('1 friend joined with your link.')).toBeVisible();
  await referrer.context().close();
  expect(w.problems).toEqual([]);
});

test('the owner sees the signups, opens one, changes it and removes it with the confirm dialog', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/people?w=${wlId}`);
  await expect(page.getByRole('table', { name: 'Signups' })).toContainText('First Person');
  await expect(page.getByRole('table', { name: 'Signups' })).toContainText('Fran Friend');
  await shoot(page, 'waitlist', 'people');

  await page.getByRole('searchbox').fill('fran');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Signups' })).not.toContainText('First Person');
  await page.goto(`/app/waitlist/people?w=${wlId}&q=zzz-nobody`);
  await expect(page.getByRole('heading', { name: 'No one matches these filters' })).toBeVisible();

  await page.goto(`/app/waitlist/people?w=${wlId}`);
  await page.getByRole('link', { name: /Fran Friend/ }).click();
  await shoot(page, 'waitlist', 'person');
  await page.locator('#p-name').fill('Fran Renamed');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fran Renamed' })).toBeVisible();

  // Tag from the list, then take the tag back off.
  await page.goto(`/app/waitlist/people?w=${wlId}`);
  await page.getByLabel('Select Fran Renamed').check();
  await page.getByLabel('Tag name').fill('vip');
  await page.getByRole('button', { name: 'Add tag' }).click();
  await page.goto(`/app/waitlist/people?w=${wlId}&tag=vip`);
  await expect(page.getByRole('table', { name: 'Signups' })).toContainText('Fran Renamed');

  await page.goto(`/app/waitlist/people?w=${wlId}`);
  await page.getByRole('link', { name: /Fran Renamed/ }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Removed.', { exact: true })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Signups' })).not.toContainText('Fran Renamed');
  expect(w.problems).toEqual([]);
});

test('held signups go to review, and approving lets them in', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/edit?w=${wlId}`);
  await page.locator('#f-disposable').fill('throwaway.example');
  await page.locator('#f-fraud').selectOption('strict');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  const visitor = await visitorPage(browser);
  await visitor.goto(`/w/${SLUG}`);
  await join(visitor, 'held@throwaway.example', 'Held Person');
  await visitor.waitForTimeout(500);
  await visitor.context().close();

  await page.goto(`/app/waitlist/review?w=${wlId}`);
  const table = page.getByRole('table', { name: 'Held for review' });
  await expect(table).toContainText('Held Person');
  await shoot(page, 'waitlist', 'review');
  await page.getByLabel('Select Held Person').check();
  await page.getByRole('button', { name: 'Approve selected' }).click();
  await expect(page.getByText('Approved 1 person.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Nothing to review' })).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('launch: a wave and a broadcast draft, with sending held until a test goes out', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/launch?w=${wlId}`);
  await expect(page.getByRole('heading', { name: 'Invite waves' })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('First wave');
  await page.getByLabel('How many people to invite').fill('1');
  await page.getByRole('button', { name: 'Create wave' }).click();
  await expect(page.getByText('Wave created.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Invite waves' })).toContainText('First wave');

  await page.getByLabel('Subject', { exact: true }).fill('A quick update');
  await page.getByLabel('Message', { exact: true }).fill('The shed is open soon.\n\nThanks for waiting.');
  await page.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByRole('heading', { name: 'A quick update' })).toBeVisible();
  await expect(page.getByText('Send a test first.')).toBeVisible();
  await shoot(page, 'waitlist', 'launch');
  await page.getByRole('button', { name: 'Discard' }).click();
  await expect(page.getByText('cancelled', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Discard' })).toBeHidden();
  expect(w.problems).toEqual([]);
});

test('stats show the real numbers and the 7 day range', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/stats?w=${wlId}`);
  await expect(page.getByText('On the list')).toBeVisible();
  await shoot(page, 'waitlist', 'stats');
  await page.getByRole('link', { name: '7 days' }).click();
  await expect(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page');
  expect(w.problems).toEqual([]);
});

test('data: import with the columns matched, export and erase one person', async ({ page }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/data?w=${wlId}`);
  await page.locator('#imp-text').fill('email,name\nivy@example.com,Ivy Import\nnot-an-email,Nobody');
  await page.getByRole('button', { name: 'Read the file' }).click();
  await expect(page.getByRole('heading', { name: 'Match your columns' })).toBeVisible();
  await shoot(page, 'waitlist', 'import-map');
  await page.getByRole('button', { name: /^Import 2 rows/ }).click();
  await expect(page.getByText(/Added 1, skipped 0 already on the list and 1 invalid/)).toBeVisible();

  await page.goto(`/app/waitlist/people?w=${wlId}`);
  await expect(page.getByRole('table', { name: 'Signups' })).toContainText('Ivy Import');

  const csv = await page.request.get(`/api/v1/waitlist/waitlists/${wlId}/export.csv`);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('ivy@example.com');

  await page.goto(`/app/waitlist/data?w=${wlId}`);
  await page.getByLabel('Their email address').fill('nobody@example.com');
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(page.getByText('No one with that address is on this waitlist.')).toBeVisible();
  await page.getByLabel('Their email address').fill('ivy@example.com');
  await page.getByRole('button', { name: 'Erase', exact: true }).click();
  await expect(page.getByText('Erased. The waitlist keeps an anonymous count.')).toBeVisible();
  await shoot(page, 'waitlist', 'data');
  expect(w.problems).toEqual([]);
});

test('test mode, the embed snippets, and deleting the waitlist with the confirm dialog', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(`/app/waitlist/edit?w=${wlId}`);
  await expect(page.getByText('0 test signups right now.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear test signups' })).toBeDisabled();
  await expect(page.getByText('data-toolshed-waitlist').first()).toBeVisible();
  await expectNoSideScroll(page);

  // The embed script puts the form into a page of the visitor's own.
  const host = await visitorPage(browser);
  await host.route('**/host.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Host</title><div data-toolshed-waitlist="${SLUG}"></div><script src="${baseURL}/m/waitlist/embed.js"></script>` }),
  );
  await host.goto(`${baseURL}/host.html`);
  await expect(host.frameLocator('iframe[title="Join the waitlist"]').getByLabel('Email')).toBeVisible();
  await host.context().close();

  await page.getByRole('button', { name: 'Delete waitlist' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete waitlist' }).click();
  await expect(page.getByText('Deleted Shed launch.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No waitlists yet' })).toBeVisible();

  const gone = await page.request.get(`/w/${SLUG}`);
  expect(gone.status()).toBe(404);
  expect(w.problems).toEqual([]);
});
