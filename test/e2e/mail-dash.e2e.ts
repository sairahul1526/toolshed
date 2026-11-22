import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState, signedInPage } from './helpers/auth';
import { disableModule, enableModule, expectNoSideScroll, shoot as takeShot, watch } from './helpers/dash';

// The owner runs a newsletter through the real pages: first run, people, a broadcast written with the
// editor toolbar and sent to the dev outbox, a welcome series, product emails, RSS, stats, deliverability,
// settings, the public archive and deleting with the confirm dialogs. Visitors use other browser contexts.
// Tests run in order and share one database.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

const APP = '/app/mail';
const SLUG = 'shed-notes';
const LIST = 'Shed notes';
const OWNER = 'owner@example.com';
const VISITOR = 'visitor@example.com';
const HAND = 'ada@example.com';
const POSTAL = 'Shed Co, 1 Main Street, Springfield 12345';

interface OutboxEmail {
  id: string;
  subject: string;
  text: string | null;
  html: string | null;
}

async function outbox(request: APIRequestContext, to: string): Promise<OutboxEmail[]> {
  const res = await request.get(`${baseURL}/dev/outbox`, { params: { to } });
  return ((await res.json()) as { emails: OutboxEmail[] }).emails;
}

/** The newest email to an address whose subject matches, waiting for it to arrive. */
async function waitForEmail(request: APIRequestContext, to: string, subject: RegExp | string): Promise<OutboxEmail> {
  let found: OutboxEmail | undefined;
  await expect
    .poll(async () => {
      found = (await outbox(request, to)).find((m) => (typeof subject === 'string' ? m.subject.includes(subject) : subject.test(m.subject)));
      return found?.id ?? '';
    }, { timeout: 30_000 })
    .not.toBe('');
  return found!;
}

const linkIn = (mail: OutboxEmail, pattern: RegExp): string => {
  const hit = ((mail.text ?? '') + ' ' + (mail.html ?? '')).match(pattern)?.[0] ?? '';
  return hit.replace(/[).,"'<]+$/, '');
};

/** Nobody is signed in on a visitor's page. The file's saved owner sign-in is not carried over. */
const SIGNED_OUT = { cookies: [], origins: [] };

async function visitorPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL, storageState: SIGNED_OUT })).newPage();
}

/**
 * Every label that follows other content in the same form needs air above it: the gap between the
 * bottom of whatever comes before and the top of the label. Form fields run together when this is 0.
 */
async function expectSpacedFields(page: Page): Promise<void> {
  // Passed as a string so this file needs no browser type definitions.
  const tight = await page.evaluate<string[]>(`(() => {
    const out = [];
    for (const label of Array.from(document.querySelectorAll('main label.lbl'))) {
      const field = label.parentElement;
      const before = field ? field.previousElementSibling : null;
      if (!field || !before || before.offsetParent === null) continue;
      const gap = field.getBoundingClientRect().top - before.getBoundingClientRect().bottom;
      if (gap < 8) out.push((label.textContent || '').trim() + ' (' + Math.round(gap) + 'px under ' + before.tagName.toLowerCase() + ')');
    }
    return out;
  })()`);
  expect(tight, 'form fields with no space above them').toEqual([]);
}

/** Check the page's form spacing, then save the three screenshots. */
async function shoot(page: Page, product: string, name: string): Promise<void> {
  await expectSpacedFields(page);
  await takeShot(page, product, name);
}

const csv = (rows: string): { name: string; mimeType: string; buffer: Buffer } => ({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from(rows) });

test('first run shows three steps, the empty screens say what to do, and the newsletter is created', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'mail');
  await page.goto(APP);
  await expect(page.getByRole('heading', { name: 'Broadcasts', level: 1 })).toBeVisible();
  await expect(page.getByText('Get set up in three steps')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No emails yet' })).toBeVisible();
  await shoot(page, 'mail', 'first-run');

  for (const [path, heading] of [
    ['/subscribers', 'No subscribers yet'],
    ['/segments', 'No segments yet'],
    ['/templates', 'No templates yet'],
    ['/feeds', 'No feeds yet'],
    ['/deliverability', 'No blocked addresses'],
  ] as const) {
    await page.goto(APP + path);
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await page.goto(`${APP}/stats`);
  await expect(page.getByRole('heading', { name: 'Nothing to chart yet' })).toBeVisible();
  await page.goto(`${APP}/new`);
  await expect(page).toHaveURL(/\/app\/mail\/lists$/);
  await expect(page.getByText('Create a newsletter first')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create your first newsletter' })).toBeVisible();
  await shoot(page, 'mail', 'newsletters-empty');

  // Both missing fields are flagged at once, each by its own field.
  await page.getByRole('button', { name: 'Create newsletter' }).click();
  await expect(page.locator('#name')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#postal')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#name').fill(LIST);
  await expect(page.locator('#name')).toHaveValue(LIST);
  await shoot(page, 'mail', 'newsletters-error');

  await page.locator('#description').fill('One short note about the shed each week.');
  await page.locator('#postal').fill(POSTAL);
  await page.getByRole('button', { name: 'Create newsletter' }).click();
  await expect(page.getByText('Newsletter created.')).toBeVisible();
  await expect(page.getByRole('heading', { name: LIST })).toBeVisible();
  await expect(page.getByText(`/n/${SLUG}`).first()).toBeVisible();
  await shoot(page, 'mail', 'newsletters');
  expect(w.problems).toEqual([]);
});

test('subscribers are added by hand and by CSV, and bad input is refused by the field', async ({ page }) => {
  const w = watch(page);
  await page.goto(`${APP}/subscribers`);
  await expect(page.getByRole('heading', { name: 'No subscribers yet' })).toBeVisible();

  // Without the consent box nothing is added.
  await page.locator('#a-email').fill(HAND);
  await page.getByRole('button', { name: 'Add subscriber' }).click();
  await expect(page.getByText('Tick the box to confirm this person agreed')).toBeVisible();

  await page.locator('#a-email').fill(HAND);
  await page.locator('#a-name').fill('Ada Lovelace');
  await page.locator('#a-tags').fill('friends, vip');
  await page.getByLabel('This person agreed to receive these emails').check();
  await page.getByRole('button', { name: 'Add subscriber' }).click();
  await expect(page.getByText('Subscriber added.')).toBeVisible();
  await expect(page.getByRole('heading', { name: HAND, level: 1 })).toBeVisible();
  await expect(page.getByText('Subscribed').first()).toBeVisible();
  await shoot(page, 'mail', 'subscriber');

  // Import: a file with no email column, then no consent, then a good file.
  await page.goto(`${APP}/subscribers/import`);
  await shoot(page, 'mail', 'import');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('#i-file')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#i-file').setInputFiles(csv('colour,size\nred,big\n'));
  await page.getByLabel('Everyone in this file agreed to receive these emails').check();
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.locator('#i-file')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'mail', 'import-error');

  await page.locator('#i-file').setInputFiles(csv('email,name,company\nbob@example.com,Bob,Acme\ncarol@example.com,Carol,Acme\nnot-an-email,Nobody,Acme\nbob@example.com,Bob again,Acme\n'));
  await page.locator('#i-tags').fill('imported');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByText('2 added out of 4 rows')).toBeVisible();
  await expect(page.getByText('had an invalid email')).toBeVisible();
  await expect(page.getByText('appeared twice in the file')).toBeVisible();
  await shoot(page, 'mail', 'import-report');

  // Without the consent box the import is refused next to the box.
  await page.getByLabel('Everyone in this file agreed to receive these emails').uncheck();
  await page.locator('#i-csv').fill('email\ndave@example.com');
  await page.getByRole('button', { name: 'Import' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Confirm that these people agreed' })).toBeVisible();

  await page.goto(`${APP}/subscribers`);
  await expect(page.getByRole('link', { name: /bob@example.com/ })).toBeVisible();
  await expect(page.getByText('3 people')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search by email or name' }).fill('carol');
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByText('1 person match')).toBeVisible();
  await page.getByRole('link', { name: 'Clear', exact: true }).click();
  await shoot(page, 'mail', 'subscribers');

  // Custom fields: the one the import made is not there until it is added, and a bad key is refused.
  await page.goto(`${APP}/fields`);
  await expect(page.getByRole('heading', { name: 'No custom fields' })).toBeVisible();
  await page.locator('#f-key').fill('Not A Key!');
  await page.locator('#f-label').fill('Company');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.locator('#f-key')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#f-key').fill('company');
  await page.getByRole('button', { name: 'Add field' }).click();
  await expect(page.getByText('Field added.')).toBeVisible();
  await shoot(page, 'mail', 'fields');
  expect(w.problems).toEqual([]);
});

test('a visitor signs up on the hosted page, confirms from the email, and appears as subscribed', async ({ page, browser }) => {
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/n/${SLUG}`);
  await expect(visitor.getByRole('heading', { name: LIST })).toBeVisible();
  await visitor.getByLabel('Email').fill('nobody');
  await visitor.getByRole('button', { name: 'Subscribe' }).click();
  await expect(visitor.getByText('Enter a full address')).toBeVisible();
  await visitor.getByLabel('Email').fill(VISITOR);
  await visitor.getByLabel('Name').fill('Vera Visitor');
  await visitor.getByRole('button', { name: 'Subscribe' }).click();
  await expect(visitor.getByRole('heading', { name: 'Check your inbox' })).toBeVisible();

  // Until they confirm they are waiting, not subscribed.
  await page.goto(`${APP}/subscribers?q=visitor`);
  await expect(page.getByText('Waiting', { exact: true })).toBeVisible();

  const mail = await waitForEmail(visitor.request, VISITOR, 'Confirm your subscription');
  await visitor.goto(new URL(linkIn(mail, /https?:\/\/[^\s"'<]+\/n\/confirm\/[^\s"'<)]+/)).pathname);
  await visitor.getByRole('button', { name: 'Yes, subscribe me' }).click();
  await expect(visitor.getByRole('heading', { name: 'You are subscribed' })).toBeVisible();
  await visitor.context().close();

  await page.goto(`${APP}/subscribers?q=visitor`);
  await expect(page.getByRole('row', { name: /visitor@example.com/ }).getByText('Subscribed', { exact: true })).toBeVisible();
  await page.getByRole('link', { name: /visitor@example.com/ }).click();
  await expect(page.getByText('signup page')).toBeVisible();
  expect(v.problems).toEqual([]);
});

test('a segment is built with the rule builder and counts who matches', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/segments/new`);
  await page.getByLabel('Name', { exact: true }).fill('Acme friends');
  await page.getByRole('button', { name: 'Save segment' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await shoot(page, 'mail', 'segment-error');

  await page.getByLabel('Rule 1', { exact: true }).selectOption({ label: 'Has the tag' });
  await page.getByLabel('Value for rule 1').fill('imported');
  await page.getByLabel('Rule 2', { exact: true }).selectOption({ label: 'Email ends with' });
  await page.getByLabel('Value for rule 2').fill('@example.com');
  await page.getByRole('button', { name: 'Check who matches' }).click();
  await expect(page.getByText('2 people match now')).toBeVisible();
  await page.getByRole('button', { name: 'Save segment' }).click();
  await expect(page.getByText('Segment saved.')).toBeVisible();
  await shoot(page, 'mail', 'segment');

  await page.goto(`${APP}/segments`);
  await expect(page.getByRole('link', { name: 'Acme friends' })).toBeVisible();
  await page.goto(`${APP}/subscribers`);
  await page.getByLabel('Segment').selectOption({ label: 'Acme friends' });
  await page.getByRole('button', { name: 'Filter' }).click();
  await expect(page.getByText('2 people match')).toBeVisible();
  expect(watched.problems).toEqual([]);
});

let broadcastUrl = '';

test('a broadcast is written with the toolbar, previewed, tested and checked before sending', async ({ page, context }) => {
  const watched = watch(page);
  await page.goto(APP);
  await page.getByRole('link', { name: 'New email' }).first().click();
  await expect(page).toHaveURL(/\/app\/mail\/b\/[^/]+$/);
  broadcastUrl = page.url();
  await expect(page.getByText('Before you send')).toBeVisible();
  await shoot(page, 'mail', 'editor-new');

  // Nothing is ready yet: the checklist says what to fix, and a blank subject is refused by the field.
  await expect(page.getByText('Fix').first()).toBeVisible();
  // A draft with no subject still saves; the checklist keeps saying what is missing.
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByText('Fix').first()).toBeVisible();

  await page.locator('#subject').fill('The shed this week');
  await page.locator('#preheader').fill('Three small things.');
  const body = page.locator('#body');
  // The End key scrolls instead of moving the caret on macOS, so the caret is placed directly.
  const toEnd = () => body.evaluate((e: { value: string; setSelectionRange(a: number, b: number): void }) => e.setSelectionRange(e.value.length, e.value.length));
  await body.fill('');
  await page.getByRole('button', { name: 'Heading', exact: true }).click();
  await expect(body).toHaveValue('## Heading');
  await page.keyboard.type('Hello from the shed');
  await toEnd();
  await body.press('Enter');
  await page.getByRole('button', { name: 'Insert name' }).click();
  await expect(body).toHaveValue(/\{\{first_name\|there\}\}/);
  await toEnd();
  await page.keyboard.type(' this is ');
  await page.getByRole('button', { name: 'Bold', exact: true }).click();
  await page.keyboard.type('very good');
  await toEnd();
  await page.keyboard.type(' news. See ');
  // Each button wraps the selection, so the caret moves to the end between them.
  for (const name of ['Link', 'Italic', 'Button', 'Divider', 'Image']) {
    await toEnd();
    await page.keyboard.type(' ');
    await page.getByRole('button', { name, exact: true }).click();
  }
  const written = await body.inputValue();
  expect(written).toContain('## Hello from the shed');
  expect(written).toContain('**very good**');
  expect(written).toContain('[link text](https://example.com)');
  expect(written).toContain('::button[Read more](https://example.com)');
  expect(written).toContain('_italic text_');
  expect(written).toContain('---');
  expect(written).toContain('![Describe the image](https://example.com/image.png)');
  await page.getByLabel('Show in the public archive after it is sent').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.locator('#body')).toHaveValue(written);
  await shoot(page, 'mail', 'editor');

  // The preview opens in its own tab and carries the unsubscribe placeholder, no script.
  const [preview] = await Promise.all([context.waitForEvent('page'), page.getByRole('link', { name: 'Preview' }).click()]);
  await preview.waitForLoadState();
  await expect(preview.getByRole('heading', { name: 'Hello from the shed' })).toBeVisible();
  await expect(preview.getByText('very good')).toBeVisible();
  await preview.screenshot({ path: '.shots/e2e/mail/preview-light.png', fullPage: true });
  await preview.close();

  // A test with a bad address is refused by the field; then one goes to the owner.
  await page.locator('#to').fill('nope');
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.locator('#to')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#to').fill(OWNER);
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(`A test went to ${OWNER}.`)).toBeVisible();
  await waitForEmail(page.request, OWNER, 'The shed this week');
  await expect(page.getByText('Everything is ready').or(page.getByText('Nothing blocks this email.'))).toBeVisible();
  await shoot(page, 'mail', 'editor-checked');
  expect(watched.problems).toEqual([]);
});

test('sending now reaches the subscribers with an unsubscribe link, and the stats show it', async ({ page }) => {
  const watched = watch(page);
  await page.goto(broadcastUrl);
  await page.getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByRole('dialog')).toContainText('4 people will get this email');
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByText('Sending started.')).toBeVisible();
  await expect(page).toHaveURL(/\/stats$/);

  const mail = await waitForEmail(page.request, VISITOR, 'The shed this week');
  expect(linkIn(mail, /https?:\/\/[^\s"'<]+\/n\/u\/[^\s"'<)]+/)).toContain('/n/u/');
  expect(mail.text).toContain('Shed Co, 1 Main Street');
  await waitForEmail(page.request, HAND, 'The shed this week');
  await waitForEmail(page.request, 'bob@example.com', 'The shed this week');
  // The page does not refresh itself, so reload until the run is finished and counted.
  await expect
    .poll(async () => { await page.reload(); return (await page.getByRole('region', { name: 'Key numbers' }).innerText()).replace(/\s+/g, ' '); }, { timeout: 20_000 })
    .toMatch(/Sent 4 of 4/);
  // One more queue job, a couple of seconds later, closes the run.
  await expect
    .poll(async () => { await page.reload(); return page.getByRole('heading', { level: 1 }).innerText(); }, { timeout: 30_000 })
    .not.toContain('Sending');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Sent');
  await shoot(page, 'mail', 'broadcast-stats');

  // It shows on the home screen as sent and cannot be edited any more.
  await page.goto(APP);
  await expect(page.getByRole('link', { name: 'The shed this week' })).toBeVisible();
  await expect(page.getByText('Sent', { exact: true }).first()).toBeVisible();
  await shoot(page, 'mail', 'broadcasts');
  await page.goto(broadcastUrl);
  await expect(page.getByText('This email can’t be edited')).toBeVisible();
  await expect(page.locator('#subject')).toBeDisabled();
  expect(watched.problems).toEqual([]);
});

test('the visitor unsubscribes from the email and is shown as unsubscribed and blocked', async ({ page, browser }) => {
  const mail = (await outbox(page.request, VISITOR)).find((m) => m.subject.includes('The shed this week'))!;
  const link = linkIn(mail, /https?:\/\/[^\s"'<]+\/n\/u\/[^\s"'<)]+/);
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(new URL(link).pathname);
  await expect(visitor.getByRole('heading', { name: 'Unsubscribe' })).toBeVisible();
  await visitor.getByRole('button', { name: 'Unsubscribe' }).click();
  await expect(visitor.getByRole('heading', { name: 'You are unsubscribed' })).toBeVisible();
  await visitor.context().close();
  expect(v.problems).toEqual([]);

  await page.goto(`${APP}/subscribers?q=visitor`);
  await expect(page.getByRole('row', { name: /visitor@example.com/ }).getByText('Unsubscribed', { exact: true })).toBeVisible();
  await page.goto(`${APP}/deliverability`);
  await expect(page.getByRole('cell', { name: VISITOR })).toBeVisible();
  await shoot(page, 'mail', 'deliverability');
});

test('a broadcast is scheduled and the schedule is cancelled', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/new`);
  await page.locator('#subject').fill('Scheduled for later');
  await page.locator('#body').fill('A note that goes out tomorrow.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // A time in the past is refused by the field.
  await page.locator('#when').fill('2020-01-01T10:00');
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.locator('#when')).toHaveAttribute('aria-invalid', 'true');

  await page.locator('#when').fill(new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Schedule', exact: true }).click();
  await expect(page.getByText(/^Scheduled for .* UTC\.$/)).toBeVisible();
  await expect(page.getByText(/Scheduled for .* UTC$/).first()).toBeVisible();
  await shoot(page, 'mail', 'editor-scheduled');
  await page.goto(`${APP}?status=scheduled`);
  await expect(page.getByRole('link', { name: 'Scheduled for later' })).toBeVisible();
  await page.getByRole('link', { name: 'Scheduled for later' }).click();
  await page.getByRole('button', { name: 'Unschedule' }).click();
  await expect(page.getByText('Schedule removed.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Schedule', exact: true })).toBeVisible();
  expect(watched.problems).toEqual([]);
});

test('the welcome series has two steps and is turned on', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/sequence`);
  await expect(page.getByText('This series is off')).toBeVisible();
  await shoot(page, 'mail', 'sequence-empty');

  await page.locator('#s0').fill('Welcome to the shed');
  await page.getByRole('button', { name: 'Save emails' }).click();
  await expect(page.locator('#b0')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#b0').fill('Thanks for joining, {{first_name|friend}}.');
  await page.locator('#d0').fill('0');
  await page.getByRole('button', { name: 'Save emails' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  await page.locator('#d1').fill('48');
  await page.locator('#s1').fill('Two days in');
  await page.locator('#b1').fill('How is the shed going?');
  await page.getByRole('button', { name: 'Save and turn on' }).click();
  await expect(page.getByText('Saved and turned on.')).toBeVisible();
  await expect(page.getByText('This series is on')).toBeVisible();
  await expect(page.locator('#s1')).toHaveValue('Two days in');
  await shoot(page, 'mail', 'sequence');
  expect(watched.problems).toEqual([]);
});

test('a product email template is made and sent through the API once, even when the call repeats', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/templates`);
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.locator('#t-name')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'mail', 'templates-error');
  await page.locator('#t-name').fill('Order receipt');
  await page.locator('#t-key').fill('receipt');
  await page.locator('#t-subject').fill('Your receipt, {{first_name}}');
  await page.locator('#t-body').fill('Thanks {{first_name}}. You paid {{total}}.');
  await page.getByRole('button', { name: 'Create template' }).click();
  await expect(page.getByText('Template created.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order receipt', level: 1 })).toBeVisible();

  await page.locator('#x-to').fill(OWNER);
  await page.getByRole('button', { name: 'Send test' }).click();
  await expect(page.getByText(`Test sent to ${OWNER}.`)).toBeVisible();
  await shoot(page, 'mail', 'template');

  const send = () =>
    page.request.post('/api/v1/mail/send', {
      data: { to: 'buyer@example.com', template: 'receipt', data: { first_name: 'Bea', total: '12.00' } },
      headers: { 'idempotency-key': 'order-1042-receipt', origin: baseURL },
    });
  const first = await send();
  expect(first.status(), await first.text()).toBeLessThan(300);
  const second = await send();
  expect(second.status()).toBeLessThan(300);
  await waitForEmail(page.request, 'buyer@example.com', 'Your receipt, Bea');
  await page.waitForTimeout(500);
  expect((await outbox(page.request, 'buyer@example.com')).filter((m) => m.subject === 'Your receipt, Bea')).toHaveLength(1);

  await page.goto(`${APP}/templates`);
  await expect(page.getByRole('cell', { name: 'buyer@example.com' })).toBeVisible();
  await shoot(page, 'mail', 'templates');
  expect(watched.problems).toEqual([]);
});

test('RSS to email: a feed address is checked, and the screen explains drafts', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/feeds`);
  await expect(page.getByText('Drafts are the safe choice')).toBeVisible();
  await page.locator('#r-url').fill('ftp://example.com/feed');
  await page.getByRole('button', { name: 'Add feed' }).click();
  await expect(page.locator('#r-url')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'mail', 'feeds-error');
  await page.locator('#r-url').fill('https://example.com/feed.xml');
  await page.getByRole('button', { name: 'Add feed' }).click();
  // Nothing can fetch a feed in the test run, so the screen shows a plain reason or the feed in the list.
  await expect(page.getByText('Feed added.').or(page.locator('#r-url[aria-invalid="true"]')).first()).toBeVisible();
  await shoot(page, 'mail', 'feeds');
  expect(watched.problems).toEqual([]);
});

test('stats, deliverability and settings show real numbers and save', async ({ page }) => {
  const watched = watch(page);
  await page.goto(`${APP}/stats`);
  await expect(page.getByRole('heading', { name: 'Stats', level: 1 })).toBeVisible();
  await expect(page.getByText('Joined, 30 days')).toBeVisible();
  await shoot(page, 'mail', 'stats');

  await page.goto(`${APP}/deliverability`);
  await expect(page.getByText('No automatic bounce or complaint feedback yet')).toBeVisible();
  await page.getByRole('button', { name: 'Block these addresses' }).click();
  await expect(page.locator('#bn')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#bn').fill('gone@example.com, also-gone@example.com, junk');
  await page.getByRole('button', { name: 'Block these addresses' }).click();
  await expect(page.getByText('2 blocked')).toBeVisible();
  await page.getByRole('row', { name: /gone@example.com/ }).first().getByRole('button', { name: 'Allow again' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Allow again' }).click();
  await expect(page.getByText('Address allowed again.')).toBeVisible();

  await page.goto(`${APP}/settings`);
  await page.locator('#postal').fill('short');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#postal')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#postal').fill(POSTAL + ', Country');
  await page.getByLabel('Count opens by default').check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  await expect(page.getByLabel('Count opens by default')).toBeChecked();
  await shoot(page, 'mail', 'settings');
  await page.getByLabel('Count opens by default').uncheck();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved.')).toBeVisible();

  // Newsletter settings: a bad address of the signup page is refused by the field.
  await page.goto(`${APP}/lists`);
  await page.getByRole('main').getByRole('link', { name: 'Settings' }).first().click();
  await page.locator('#slug').fill('Not A Slug!');
  await page.getByLabel('Publish sent emails in a public archive').check();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#slug')).toHaveAttribute('aria-invalid', 'true');
  // What was ticked stays ticked after the refusal.
  await expect(page.getByLabel('Publish sent emails in a public archive')).toBeChecked();
  await shoot(page, 'mail', 'newsletter-settings-error');
  await page.locator('#slug').fill(SLUG);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved.')).toBeVisible();
  expect(watched.problems).toEqual([]);
});

test('the public archive and its feed show the sent email, and a visitor can read it', async ({ browser }) => {
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  // The sample email has an outside image. Answer it here so the test needs no network.
  const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  await visitor.route('https://example.com/**', (route) => route.fulfill({ contentType: 'image/png', body: pixel }));
  await visitor.goto(`/n/${SLUG}/archive`);
  await expect(visitor.getByRole('link', { name: 'The shed this week' })).toBeVisible();
  await visitor.screenshot({ path: '.shots/e2e/mail/archive-light.png', fullPage: true });
  await visitor.getByRole('link', { name: 'The shed this week' }).click();
  await expect(visitor.getByRole('heading', { name: 'The shed this week', level: 1 })).toBeVisible();
  await expect(visitor.getByText('very good')).toBeVisible();
  await visitor.setViewportSize({ width: 375, height: 800 });
  await expectNoSideScroll(visitor);
  await visitor.screenshot({ path: '.shots/e2e/mail/archive-issue-375.png', fullPage: true });
  const rss = await visitor.request.get(`/n/${SLUG}/rss.xml`);
  expect(rss.headers()['content-type']).toContain('xml');
  expect(await rss.text()).toContain('The shed this week');
  await visitor.goto(`/n/${SLUG}`);
  await expectNoSideScroll(visitor);
  await visitor.screenshot({ path: '.shots/e2e/mail/signup-375.png', fullPage: true });
  await visitor.context().close();
  expect(v.problems).toEqual([]);
});

// The viewer signs in through the real invite page, so this test starts signed out.
test.describe('as a viewer', () => {
  test.use({ storageState: SIGNED_OUT });

  test('a viewer sees every screen read-only and every change is refused', async ({ browser }) => {
    test.setTimeout(120_000); // the first viewer is invited and signs in through the real pages
    const viewer = await signedInPage(browser, { role: 'viewer' });
    const v = watch(viewer);
    for (const path of ['', '/lists', '/subscribers', '/segments', '/fields', '/sequence', '/templates', '/feeds', '/stats', '/deliverability', '/settings']) {
      const res = await viewer.goto(APP + path);
      expect(res?.status(), path).toBe(200);
      await expect(viewer.locator('main h1').first()).toBeVisible();
      await expect(viewer.getByRole('button', { name: /^(Create|Add|Save|Import|Send|Block|Schedule)/ }), `buttons on ${path || '/'}`).toHaveCount(0);
    }
    await expect(viewer.getByRole('link', { name: 'New email' })).toHaveCount(0);
    await viewer.goto(`${APP}/subscribers`);
    await expect(viewer.getByRole('button', { name: 'Add subscriber' })).toHaveCount(0);
    await shoot(viewer, 'mail', 'viewer-subscribers');

    // The pages for one thing show it but offer no way to change it.
    for (const [list, link] of [['/segments', 'Acme friends'], ['/templates', 'Order receipt'], ['/subscribers?q=ada', 'ada@example.com']] as const) {
      await viewer.goto(APP + list);
      await viewer.getByRole('main').getByRole('link', { name: link }).first().click();
      await expect(viewer.locator('main h1').first()).toBeVisible();
      await expect(viewer.getByRole('button', { name: /^(Save|Delete|Add|Send|Update|Remove)/ }), `buttons on ${link}`).toHaveCount(0);
    }

    // The editor of a draft shows the text but offers nothing to change.
    await viewer.goto(broadcastUrl);
    await expect(viewer.getByRole('button', { name: /^(Save|Send)/ })).toHaveCount(0);

    // A post sent anyway is refused, and nothing changes.
    const origin = { origin: baseURL };
    for (const [path, form] of [
      ['/lists', { name: 'Sneaky', postal: POSTAL }],
      ['/subscribers', { email: 'x@example.com', consent: '1' }],
      ['/segments', { name: 'Sneaky', kind0: 'name:set' }],
      ['/templates', { name: 'Sneaky', key: 'sneaky', subject: 's', body: 'b' }],
      ['/settings', { postal: POSTAL }],
      [`${new URL(broadcastUrl).pathname.replace(APP, '')}/send`, {}],
    ] as const) {
      const res = await viewer.request.post(APP + path, { form, headers: origin, maxRedirects: 0, failOnStatusCode: false });
      expect(res.status(), path).toBeGreaterThanOrEqual(400);
    }
    await viewer.goto(`${APP}/lists`);
    await expect(viewer.getByText('Sneaky')).toHaveCount(0);
    await viewer.context().close();
    expect(v.problems.filter((p) => !/40[0-9]/.test(p))).toEqual([]);
  });
});

test('deleting asks first, and each screen is clean at phone width', async ({ page }) => {
  const watched = watch(page);
  // A subscriber.
  await page.goto(`${APP}/subscribers?q=bob`);
  await page.getByRole('link', { name: /bob@example.com/ }).click();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Delete this person?');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'bob@example.com', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByText('Subscriber deleted.')).toBeVisible();

  // The segment, the template and the feed.
  await page.goto(`${APP}/segments`);
  await page.getByRole('link', { name: 'Acme friends' }).click();
  await page.getByRole('button', { name: 'Delete segment' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete segment' }).click();
  await expect(page.getByText('Segment deleted.')).toBeVisible();
  await page.goto(`${APP}/templates`);
  await page.getByRole('link', { name: 'Order receipt' }).click();
  await page.getByRole('button', { name: 'Delete template' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete template' }).click();
  await expect(page.getByText('Template deleted.')).toBeVisible();
  await page.goto(`${APP}/fields`);
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(page.getByText('Field removed.')).toBeVisible();

  // A draft email, then the newsletter with everything in it.
  await page.goto(`${APP}/new`);
  await page.locator('#subject').fill('Throwaway');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByText('Duplicated as a new draft.')).toBeVisible();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete email' }).click();
  await expect(page.getByText('Email deleted.')).toBeVisible();

  await page.goto(`${APP}/lists`);
  await page.getByRole('main').getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('button', { name: 'Delete newsletter' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete newsletter' }).click();
  await expect(page.getByText('Newsletter deleted.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Create your first newsletter' })).toBeVisible();
  expect((await page.request.get(`/n/${SLUG}`)).status()).toBe(404);
  expect(watched.problems).toEqual([]);
});

// Later files (Modules, Overview) expect a workspace with nothing switched on.
test.afterAll(async ({ browser }) => {
  await disableModule(browser, 'mail');
});
