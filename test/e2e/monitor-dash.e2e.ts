import { expect, test, type Browser, type Page } from '@playwright/test';
import { baseURL, ownerState } from './helpers/auth';
import { disableModule, enableModule, expectNoSideScroll, shoot, watch } from './helpers/dash';

// The owner sets up monitors, an alert channel, a status page, an incident and a maintenance window
// through the real pages. A visitor in another browser context pings the heartbeat and reads the
// public status page. Tests run in order and share one database. Checks of real websites are not
// run: monitors refuse local addresses and this sandbox has no outside network, so the heartbeat
// stands in for a live monitor.
test.describe.configure({ mode: 'serial' });
test.use({ storageState: ownerState });

let pingPath = '';
let heartbeatUrl = '';
const pageSlug = 'shed-status';

async function visitorPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ baseURL })).newPage();
}

test('turns on, shows the first-run screen, and refuses an address that points inside the network', async ({ page }) => {
  const w = watch(page);
  await enableModule(page, 'monitor');
  await page.goto('/app/monitor');
  await expect(page.getByRole('heading', { name: 'Monitors', level: 1 })).toBeVisible();
  await expect(page.getByText('Start with one address')).toBeVisible();
  await shoot(page, 'monitor', 'first-run');

  await page.getByLabel('Website address').fill('http://localhost/');
  await page.getByRole('button', { name: 'Check it now' }).click();
  await expect(page.getByRole('alert').first()).toBeVisible();
  await expect(page.getByLabel('Website address')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'monitor', 'first-run-error');
  expect(w.problems).toEqual([]);
});

test('creates a heartbeat monitor, with errors by the field first', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/monitor');
  await page.getByRole('link', { name: 'Create a heartbeat monitor' }).click();
  await expect(page.getByRole('heading', { name: 'New monitor' })).toBeVisible();
  await page.getByLabel('Name', { exact: false }).first().fill('Nightly backup');
  await page.locator('#hbGraceMin').fill('soon');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.locator('#hbGraceMin')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'monitor', 'new-error');

  await page.locator('#hbGraceMin').fill('30');
  await page.locator('#hbPeriodSec').selectOption('3600');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('heading', { name: 'Nightly backup', level: 1 })).toBeVisible();
  await expect(page.getByText('Waiting for your job to ping the address below.')).toBeVisible();

  const html = await page.content();
  pingPath = html.match(/\/hb\/[A-Za-z0-9_-]+/)?.[0] ?? '';
  expect(pingPath).not.toBe('');
  heartbeatUrl = page.url();
  await shoot(page, 'monitor', 'heartbeat-waiting');
  expect(w.problems).toEqual([]);
});

test('a ping from the job reaches the monitor, and the page picks it up', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto(heartbeatUrl);
  const visitor = await visitorPage(browser);
  const ok = await visitor.request.get(pingPath);
  expect(ok.status()).toBe(200);
  await visitor.context().close();

  // monitor.js polls the screen while it waits, and reloads it once the waiting is over.
  await expect(page.getByText('Waiting for your job to ping the address below.')).toBeHidden({ timeout: 20_000 });
  await expect(page.getByText(/First ping received/)).toBeVisible();
  await shoot(page, 'monitor', 'heartbeat-up');
  expect(w.problems).toEqual([]);
});

test('an http monitor is created with the full form, edited, paused and resumed', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/monitor/new');
  await page.locator('#url').fill('not a url');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.locator('#url')).toHaveAttribute('aria-invalid', 'true');
  await shoot(page, 'monitor', 'new-http-error');

  await page.locator('#name').fill('Marketing site');
  await page.locator('#url').fill('https://example.com/health');
  await page.locator('#intervalMin').selectOption('10');
  await page.getByRole('button', { name: 'Create monitor' }).click();
  await expect(page.getByRole('heading', { name: 'Marketing site', level: 1 })).toBeVisible();
  const detail = page.url();
  await expectNoSideScroll(page);

  await page.getByRole('link', { name: 'Edit' }).click();
  await page.locator('#name').fill('Marketing website');
  await page.locator('#failAfter').fill('abc');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('#failAfter')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#failAfter').fill('2');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('heading', { name: 'Marketing website', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeVisible();
  await shoot(page, 'monitor', 'detail');

  await page.goto('/app/monitor');
  await expect(page.getByRole('table', { name: 'Monitors' })).toContainText('Marketing website');
  await expect(page.getByRole('table', { name: 'Monitors' })).toContainText('Nightly backup');
  await page.getByRole('searchbox').fill('nightly');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('table', { name: 'Monitors' })).not.toContainText('Marketing website');
  await page.goto('/app/monitor?q=zzz-nobody');
  await expect(page.getByRole('heading', { name: 'No monitors match' })).toBeVisible();
  await page.goto('/app/monitor');
  await shoot(page, 'monitor', 'list');
  expect(detail).toContain('/app/monitor/m/');
  expect(w.problems).toEqual([]);
});

test('an email channel is added from the first-run card, tested, edited and kept', async ({ page, request }) => {
  const w = watch(page);
  await page.goto('/app/monitor/alerts');
  await expect(page.getByText('No alert channels yet')).toBeVisible();
  await shoot(page, 'monitor', 'alerts-empty');

  await page.getByRole('link', { name: 'Choose another channel' }).click();
  await page.locator('#name').fill('On-call email');
  await page.locator('#to').fill('not-an-email');
  await page.getByRole('button', { name: /^(Add|Save|Create)/ }).first().click();
  await expect(page.locator('#to')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#to').fill('ops@example.com');
  await page.getByRole('button', { name: /^(Add|Save|Create)/ }).first().click();
  await expect(page.getByRole('table', { name: 'Alert channels' })).toContainText('On-call email');
  await shoot(page, 'monitor', 'alerts');

  await page.getByRole('button', { name: 'Send a test' }).click();
  await expect.poll(async () => ((await (await request.get('/dev/outbox?to=ops@example.com')).json()) as { emails: unknown[] }).emails.length).toBeGreaterThan(0);

  await page.getByRole('link', { name: /On-call email/ }).click();
  await page.locator('#repeatMin').fill('30');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();
  expect(w.problems).toEqual([]);
});

test('a status page is built from components and groups, and a visitor reads it', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto('/app/monitor/pages');
  await expect(page.getByText('No status page yet')).toBeVisible();
  await shoot(page, 'monitor', 'pages-empty');

  await page.getByRole('link', { name: /New status page|Create/ }).first().click();
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.locator('#title')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#title').fill('Shed status');
  await page.getByRole('button', { name: /^Create/ }).click();
  await expect(page.getByRole('heading', { name: 'Shed status', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: `http://127.0.0.1:8841/status/${pageSlug}` })).toBeVisible();

  await page.getByRole('textbox', { name: 'New group name' }).fill('Core');
  await page.getByRole('button', { name: 'Add group' }).click();
  await page.locator('#name').fill('Backups');
  await page.locator('#monitorId').selectOption({ label: 'Nightly backup' });
  await page.locator('#groupId').selectOption({ label: 'Core' });
  await page.getByRole('button', { name: 'Add component' }).click();
  await expect(page.getByText('Backups').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'View page' }).locator('svg')).toHaveCount(1);
  await page.setViewportSize({ width: 375, height: 800 });
  const groupName = await page.getByRole('textbox', { name: 'Name of group Core' }).boundingBox();
  expect(groupName?.width ?? 0).toBeGreaterThan(120);
  await page.setViewportSize({ width: 1280, height: 800 });
  await shoot(page, 'monitor', 'page-components');

  await page.getByRole('navigation', { name: 'Status page sections' }).getByRole('link', { name: /^Settings/ }).click();
  await page.locator('#description').fill('How the shed is doing.');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();
  await shoot(page, 'monitor', 'page-settings');

  await page.getByRole('navigation', { name: 'Status page sections' }).getByRole('link', { name: /^Look/ }).click();
  await page.locator('#customCss').fill(':root { --st-ok: #0a7d5a; }');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();

  await page.getByRole('navigation', { name: 'Status page sections' }).getByRole('link', { name: /^Share/ }).click();
  await expect(page.getByText('widget.js').first()).toBeVisible();
  await shoot(page, 'monitor', 'page-share');

  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/status/${pageSlug}`);
  await expect(visitor.getByRole('heading', { name: 'Shed status' })).toBeVisible();
  await expect(visitor.getByText('Backups')).toBeVisible();
  await expect(visitor.getByText('How the shed is doing.')).toBeVisible();
  await shoot(visitor, 'monitor', 'public-status');
  for (const file of ['status.json', 'feed.rss', 'feed.atom', 'badge.svg']) {
    expect((await visitor.request.get(`/status/${pageSlug}/${file}`)).status(), file).toBe(200);
  }
  await visitor.context().close();
  expect(v.problems).toEqual([]);
  expect(w.problems).toEqual([]);
});

test('a visitor subscribes to the status page and confirms by email', async ({ browser, page }) => {
  const visitor = await visitorPage(browser);
  const v = watch(visitor);
  await visitor.goto(`/status/${pageSlug}`);
  await visitor.getByLabel(/email/i).first().fill('fan@example.com');
  await visitor.getByRole('button', { name: /subscribe/i }).first().click();
  await expect(visitor.getByText(/check your email|confirm/i).first()).toBeVisible();
  let link = '';
  await expect
    .poll(async () => {
      const mails = ((await (await visitor.request.get('/dev/outbox?to=fan@example.com')).json()) as { emails: { text: string }[] }).emails;
      link = mails.map((m) => m.text.match(/https?:\/\/\S+/)?.[0] ?? '').find(Boolean) ?? '';
      return link;
    })
    .not.toBe('');
  await visitor.goto(link.replace(/[).,]+$/, ''));
  await expect(visitor.getByText(/subscribed|confirmed/i).first()).toBeVisible();
  await visitor.context().close();

  await page.goto('/app/monitor/pages');
  await page.getByRole('link', { name: /Shed status/ }).first().click();
  await page.getByRole('navigation', { name: 'Status page sections' }).getByRole('link', { name: /^Subscribers/ }).click();
  await expect(page.getByText('fan@example.com')).toBeVisible();
  await shoot(page, 'monitor', 'page-subscribers');
  expect(v.problems).toEqual([]);
});

test('an incident is opened, updated, resolved, shown on the status page and removed', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto('/app/monitor/incidents');
  await shoot(page, 'monitor', 'incidents-empty');
  await page.goto('/app/monitor/incidents/new');
  await page.getByRole('button', { name: /^(Open|Create|Post)/ }).first().click();
  await expect(page.locator('#title')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#title').fill('Backups are slow');
  await page.locator('#body').fill('We are looking into it.');
  await page.getByRole('button', { name: /^(Open|Create|Post)/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Backups are slow', level: 1 })).toBeVisible();

  const visitor = await visitorPage(browser);
  await visitor.goto(`/status/${pageSlug}`);
  await expect(visitor.getByText('Backups are slow')).toBeVisible();
  await shoot(visitor, 'monitor', 'public-incident');

  await page.locator('#status').first().selectOption('resolved');
  await page.locator('#body').first().fill('All fixed.');
  await page.getByRole('button', { name: /^Post/ }).first().click();
  await expect(page.getByText('All fixed.').first()).toBeVisible();
  await page.locator('#postmortem').fill('The disk was full. We added space.');
  await page.getByRole('button', { name: 'Save postmortem' }).click();
  await shoot(page, 'monitor', 'incident');

  await page.getByRole('button', { name: 'Delete incident' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete incident' }).click();
  await expect(page.getByText('Backups are slow')).toBeHidden();
  await visitor.reload();
  await expect(visitor.getByText('Backups are slow')).toBeHidden();
  await visitor.context().close();
  expect(w.problems).toEqual([]);
});

test('a maintenance window is planned, shown to visitors, edited and removed', async ({ page, browser }) => {
  const w = watch(page);
  await page.goto('/app/monitor/maintenance');
  await shoot(page, 'monitor', 'maintenance-empty');
  await page.goto('/app/monitor/maintenance/new');
  await page.getByRole('button', { name: /^(Schedule|Create|Save)/ }).first().click();
  await expect(page.locator('#title')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#title').fill('Database upgrade');
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 16);
  await page.locator('#startsAt').fill(soon);
  await page.locator('#durationMin').fill('45');
  await page.getByRole('button', { name: /^(Schedule|Create|Save)/ }).first().click();
  await expect(page.getByRole('table').first()).toContainText('Database upgrade');
  await shoot(page, 'monitor', 'maintenance');

  const visitor = await visitorPage(browser);
  await visitor.goto(`/status/${pageSlug}`);
  await expect(visitor.getByText('Database upgrade')).toBeVisible();
  await visitor.context().close();

  await page.getByRole('link', { name: /Database upgrade/ }).click();
  await page.locator('#durationMin').fill('60');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await page.getByRole('link', { name: /Database upgrade/ }).click();
  await page.getByRole('button', { name: 'Delete window' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete window' }).click();
  await expect(page.getByText('Database upgrade')).toBeHidden();
  expect(w.problems).toEqual([]);
});

test('settings save, the export downloads, and a bad import is refused with a reason', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/monitor/settings');
  await page.locator('#keepDailyDays').fill('5');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.locator('#keepDailyDays')).toHaveAttribute('aria-invalid', 'true');
  await page.locator('#keepDailyDays').fill('120');
  await page.getByRole('button', { name: /^Save/ }).first().click();
  await expect(page.getByText('Saved', { exact: false }).first()).toBeVisible();
  await shoot(page, 'monitor', 'settings');

  const csv = await page.request.get('/api/v1/monitor/export/monitors.csv');
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('Nightly backup');
  expect(w.problems).toEqual([]);
});

test('channels, components, the status page and monitors are deleted with their confirm dialogs', async ({ page }) => {
  const w = watch(page);
  await page.goto('/app/monitor/alerts');
  await page.getByRole('link', { name: /On-call email/ }).click();
  await page.getByRole('button', { name: 'Delete channel' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete channel' }).click();
  await expect(page.getByText('No alert channels yet')).toBeVisible();

  await page.goto('/app/monitor/pages');
  await page.getByRole('link', { name: /Shed status/ }).first().click();
  await page.getByRole('navigation', { name: 'Status page sections' }).getByRole('link', { name: /^Settings/ }).click();
  await page.getByRole('button', { name: 'Delete status page' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete page' }).click();
  await expect(page.getByText('No status page yet')).toBeVisible();
  expect((await page.request.get(`/status/${pageSlug}`)).status()).toBe(404);

  for (const name of ['Marketing website', 'Nightly backup']) {
    await page.goto('/app/monitor');
    await page.getByRole('link', { name: new RegExp(name) }).first().click();
    await page.getByRole('button', { name: 'Delete monitor' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Delete monitor' }).click();
  }
  await expect(page.getByText('Start with one address')).toBeVisible();
  expect((await page.request.get(pingPath)).status()).toBe(404);
  expect(w.problems).toEqual([]);
});

// Later files (Modules, Overview) expect a workspace with nothing switched on.
test.afterAll(async ({ browser }) => {
  await disableModule(browser, 'monitor');
});
