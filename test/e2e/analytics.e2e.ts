import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { hashPassword } from '../../src/auth/hasher';

// The sign-in system is not part of this checkout, so the test seeds one site and two share links
// straight into the local database, then does what a stranger can do: load a page that carries the
// tracking script, and open the public dashboard. Signed-in screens are covered by the module's own
// route tests (src/modules/analytics/dashboard.test.ts).
const PORT = process.env.PORT ?? '8787';
const APP = `http://127.0.0.1:${PORT}`;
const SHOTS = '.shots';
const NOW = Date.now();
const KEY = 'e2eSiteKey01';
const OPEN = 'e2eOpenShareToken0000001';
const LOCKED = 'e2eLockedShareToken00002';
const PASSWORD = 'open-sesame-e2e';
// The script leaves localhost alone, so the pretend customer site lives on another name.
const SHOP = 'http://shop.example.com';

// The script also leaves automated browsers alone (navigator.webdriver), and the server drops
// headless user agents as bots. This test wants to be counted, so it looks like a person's browser.
test.use({
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  launchOptions: { args: ['--disable-blink-features=AutomationControlled', '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks'] },
});

function sql(command: string): string {
  return execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `.wrangler/e2e-${PORT}`, '--json', '--command', command], {
    stdio: 'pipe',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  }).toString();
}

function storedHits(): number {
  const out = JSON.parse(sql(`SELECT COUNT(*) AS n FROM an_hits WHERE site_id = 'site_e2e'`)) as { results: { n: number }[] }[];
  return out[0]?.results[0]?.n ?? 0;
}

async function seed(): Promise<void> {
  const hash = await hashPassword(PASSWORD);
  sql(
    [
      `INSERT OR REPLACE INTO module_state (org_id, module_id, enabled, enabled_at) VALUES ('org_e2e', 'analytics', 1, ${NOW})`,
      `INSERT OR REPLACE INTO an_sites (id, org_id, key, name, domain, created_at, updated_at) VALUES ('site_e2e', 'org_e2e', '${KEY}', 'Example shop', 'shop.example.com', ${NOW}, ${NOW})`,
      `INSERT OR REPLACE INTO an_goals (id, org_id, site_id, name, kind, match, created_at) VALUES ('goal_e2e', 'org_e2e', 'site_e2e', 'Signed up', 'event', 'Signup', ${NOW})`,
      `INSERT OR REPLACE INTO an_shares (id, org_id, site_id, token, name, created_at) VALUES ('shr_e2e1', 'org_e2e', 'site_e2e', '${OPEN}', 'Public dashboard', ${NOW})`,
      `INSERT OR REPLACE INTO an_shares (id, org_id, site_id, token, name, password_hash, created_at) VALUES ('shr_e2e2', 'org_e2e', 'site_e2e', '${LOCKED}', 'For the board', '${hash}', ${NOW})`,
    ].join('; '),
  );
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

/** Serve a pretend customer site: any page on it is the same small document with the snippet in its head. */
async function customerSite(page: Page, attrs = ''): Promise<void> {
  await page.route(`${SHOP}/**`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><html><head><meta charset="utf-8"><title>Example shop</title>
        <script>window.toolshed = window.toolshed || function () { (toolshed.q = toolshed.q || []).push(arguments); };</script>
        <script defer data-site="${KEY}" ${attrs} src="${APP}/m/analytics/t.js"></script></head>
        <body><h1>Example shop</h1><a id="guide" href="/files/guide.pdf">Download the guide</a></body></html>`,
    }),
  );
}

/** Collect every answer from the collect endpoint, so a test can wait for the hits it caused. */
function beacons(page: Page): { status: number; body: Record<string, unknown> }[] {
  const seen: { status: number; body: Record<string, unknown> }[] = [];
  page.on('response', (res) => {
    if (!res.url().startsWith(`${APP}/a/e`)) return;
    seen.push({ status: res.status(), body: JSON.parse(res.request().postData() ?? '{}') as Record<string, unknown> });
  });
  return seen;
}

test.beforeAll(async () => seed());

test('the script and the styles are served as static files, and the script stays under 2 KB', async ({ request }) => {
  const script = await request.get('/m/analytics/t.js');
  expect(script.status()).toBe(200);
  expect(script.headers()['content-type']).toContain('javascript');
  expect(gzipSync(await script.body()).length).toBeLessThan(2048);
  for (const path of ['/m/analytics/report.css', '/m/analytics/share.css', '/m/analytics/analytics.css']) {
    const css = await request.get(path);
    expect(css.status(), path).toBe(200);
    expect(css.headers()['content-type']).toContain('text/css');
  }
  expect((await request.get('/m/analytics/analytics.js')).status()).toBe(200);
});

test('the dashboard asks for sign-in instead of showing numbers', async ({ request }) => {
  const res = await request.get('/app/analytics', { maxRedirects: 0 });
  expect([301, 302, 303, 401, 403, 501]).toContain(res.status());
  const api = await request.get('/api/v1/analytics/sites', { maxRedirects: 0, headers: { accept: 'application/json' } });
  expect([401, 403, 501]).toContain(api.status());
});

test('the collect endpoint never shows an error to a visitor’s browser', async ({ request }) => {
  const junk = await request.post('/a/e', { headers: { 'content-type': 'text/plain' }, data: 'not json' });
  expect(junk.status()).toBe(202);
  expect(await junk.text()).toBe('');
  expect(junk.headers()['access-control-allow-origin']).toBe('*');
  const unknown = await request.post('/a/e', { headers: { 'content-type': 'text/plain' }, data: JSON.stringify({ k: 'nobody', t: 'p', u: `${SHOP}/` }) });
  expect(unknown.status()).toBe(202);
  const pixel = await request.get('/a/p.gif?k=nobody');
  expect(pixel.status()).toBe(200);
  expect(pixel.headers()['content-type']).toContain('image/gif');
});

test('a page with the snippet sends page views, route changes, events and downloads, and stores nothing in the browser', async ({ page, context }) => {
  const problems = watch(page);
  const sent = beacons(page);
  await customerSite(page);
  const before = storedHits();

  await page.goto(`${SHOP}/pricing?utm_source=newsletter&utm_medium=email`);
  await expect.poll(() => sent.length).toBe(1);
  expect(sent[0]?.status).toBe(202);
  expect(sent[0]?.body).toMatchObject({ k: KEY, t: 'p', u: `${SHOP}/pricing?utm_source=newsletter&utm_medium=email` });

  // A single-page app changes the address without loading a page.
  await page.evaluate("history.pushState({}, '', '/thanks')");
  await expect.poll(() => sent.length).toBe(2);
  expect(sent[1]?.body).toMatchObject({ t: 'p', u: `${SHOP}/thanks`, r: `${SHOP}/pricing?utm_source=newsletter&utm_medium=email` });

  await page.evaluate("toolshed('Signup', { plan: 'pro' })");
  await expect.poll(() => sent.length).toBe(3);
  expect(sent[2]?.body).toMatchObject({ t: 'e', n: 'Signup', p: { plan: 'pro' } });

  await page.evaluate("document.getElementById('guide').addEventListener('click', (e) => e.preventDefault())");
  await page.click('#guide');
  await expect.poll(() => sent.length).toBe(4);
  expect(sent[3]?.body).toMatchObject({ t: 'e', n: 'File download', p: { url: `${SHOP}/files/guide.pdf` } });
  expect(sent.every((s) => s.status === 202)).toBe(true);

  // No cookie from the app, nothing kept in the visitor's browser.
  expect(await context.cookies()).toEqual([]);
  expect(await page.evaluate('localStorage.length + sessionStorage.length')).toBe(0);
  expect(problems).toEqual([]);

  // The answer goes out before the hit is written, so give the writes a moment to land.
  await expect.poll(() => storedHits(), { timeout: 20_000, intervals: [500, 1000, 2000] }).toBe(before + 4);
});

test('the opt-out address stops this browser being counted', async ({ page }) => {
  const sent = beacons(page);
  await customerSite(page);
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${SHOP}/#toolshed-ignore`);
  await page.goto(`${SHOP}/pricing`);
  await page.waitForTimeout(500);
  expect(sent).toEqual([]);
  expect(await page.evaluate("localStorage.getItem('toolshed_ignore')")).toBe('1');
});

test('the public dashboard shows what just arrived, at phone width and in dark mode', async ({ page }) => {
  const problems = watch(page);
  const res = await page.goto(`/a/share/${OPEN}`);
  expect(res?.status()).toBe(200);
  expect(res?.headers()['cache-control']).toBe('no-store');
  expect(res?.headers()['x-robots-tag']).toBe('noindex');
  await expect(page.getByRole('heading', { name: 'Example shop', level: 1 })).toBeVisible();
  await expect(page.locator('.an-tile').filter({ hasText: 'Visitors' }).locator('b')).toHaveText('1');
  await expect(page.locator('.an-tile').filter({ hasText: 'Page views' }).locator('b')).toHaveText('2');
  await expect(page.getByText('/pricing', { exact: true })).toBeVisible();
  await expect(page.getByText('/thanks', { exact: true })).toBeVisible();
  await expect(page.getByText('newsletter', { exact: true })).toBeVisible();
  await expect(page.getByText('Signed up', { exact: true })).toBeVisible();
  await expect(page.getByText('File download', { exact: true })).toBeVisible();
  await expect(page.getByText('1 on the site now')).toBeVisible();
  // Looking only: rows are not links, and nothing leads into the workspace.
  expect(await page.locator('.an-rows a').count()).toBe(0);
  expect(await page.locator('a[href^="/app"]').count()).toBe(0);
  await page.screenshot({ path: `${SHOTS}/analytics-share-desktop.png`, fullPage: true });

  // The range picker is a plain form: it works without any script of ours.
  await page.selectOption('#an-period', 'today');
  await page.getByRole('button', { name: 'Show' }).click();
  await expect(page).toHaveURL(/period=today/);
  await expect(page.locator('.an-tile').filter({ hasText: 'Visitors' }).locator('b')).toHaveText('1');

  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/a/share/${OPEN}`);
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({ path: `${SHOTS}/analytics-share-375.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/analytics-share-dark.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('a link with a password asks for it, refuses a wrong one and opens with the right one', async ({ page }) => {
  const first = await page.goto(`/a/share/${LOCKED}`);
  expect(first?.status()).toBe(401);
  await expect(page.getByRole('heading', { name: 'This dashboard needs a password' })).toBeVisible();
  await expect(page.locator('.an-tile')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/analytics-share-password.png` });

  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('alert')).toContainText('That password is not right.');
  await page.screenshot({ path: `${SHOTS}/analytics-share-password-error.png` });

  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Example shop', level: 1 })).toBeVisible();
  await expect(page.locator('.an-tile').first()).toBeVisible();
});

test('the embed shows inside a page on another site, and a missing link says so', async ({ page }) => {
  await page.route(`${SHOP}/**`, (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><h1>Our numbers</h1><iframe src="${APP}/a/share/${OPEN}/embed" title="Example shop visitors" width="100%" height="900"></iframe></body></html>` }),
  );
  await page.goto(`${SHOP}/open`);
  const frame = page.frameLocator('iframe');
  await expect(frame.getByRole('heading', { name: 'Example shop', level: 1 })).toBeVisible();
  await expect(frame.locator('.an-tile').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/analytics-embed.png`, fullPage: true });

  const missing = await page.goto('/a/share/AAAAAAAAAAAAAAAAAAAAAAAA');
  expect(missing?.status()).toBe(404);
  await expect(page.getByText('This dashboard is not available')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/analytics-share-gone.png` });
});
