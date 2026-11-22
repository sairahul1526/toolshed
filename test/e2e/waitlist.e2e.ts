import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

// The sign-in system is not part of this checkout, so the test seeds one waitlist straight into the local database.
// It then walks the public side the way a visitor would: join, confirm by email, share, climb, leaderboard.
const PORT = process.env.PORT ?? '8787';
const SHOTS = '.shots';
const SLUG = 'e2e-launch';
const NOW = Date.now();

function seed(): void {
  const sql = `INSERT OR REPLACE INTO wl_waitlists (id, org_id, name, slug, status, headline, description, questions, fraud_level, created_at, updated_at)
    VALUES ('wl_e2e', 'org_e2e', 'E2E launch', '${SLUG}', 'live', 'Be first in line', 'A short note about what we are building.',
    '[{"id":"q1","label":"What will you use it for?","type":"text","required":false}]', 'off', ${NOW}, ${NOW})`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `.wrangler/e2e-${PORT}`, '--command', sql], { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
}

async function outbox(page: Page, to: string): Promise<{ text: string }[]> {
  const res = await page.request.get(`/dev/outbox?to=${encodeURIComponent(to)}`);
  return ((await res.json()) as { emails: { text: string }[] }).emails;
}

async function confirmLinkFor(page: Page, to: string): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const mails = await outbox(page, to);
      link = mails.map((m) => m.text.match(/https?:\/\/\S+\/confirm\/\S+/)?.[0] ?? '').find(Boolean) ?? '';
      return link;
    })
    .not.toBe('');
  return link.replace(/[).,]+$/, '');
}

/** A signup form sent within a second of loading is treated as a bot, so tests wait like a person would. */
async function submit(page: Page): Promise<void> {
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: 'Join the waitlist' }).click();
}

function watch(page: Page): string[] {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  return problems;
}

test.beforeAll(() => seed());

test('hosted page: light, dark, small screen, no cookies, small payload', async ({ page, context }) => {
  const problems = watch(page);
  const res = await page.goto(`/w/${SLUG}`);
  expect(res?.status()).toBe(200);
  expect((await res!.body()).length).toBeLessThan(30 * 1024);
  await expect(page.getByRole('heading', { name: 'Be first in line' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.getByLabel('What will you use it for?')).toBeVisible();
  expect(await context.cookies()).toHaveLength(0);
  await page.screenshot({ path: `${SHOTS}/waitlist-public-join.png`, fullPage: true });

  await page.setViewportSize({ width: 375, height: 700 });
  const overflow = await page.evaluate(() => (globalThis as unknown as { document: { documentElement: { scrollWidth: number; clientWidth: number } } }).document.documentElement.scrollWidth - (globalThis as unknown as { document: { documentElement: { clientWidth: number } } }).document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SHOTS}/waitlist-public-join-375.png`, fullPage: true });

  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await page.screenshot({ path: `${SHOTS}/waitlist-public-join-dark.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('a bad address shows an inline error and keeps what was typed', async ({ page }) => {
  await page.goto(`/w/${SLUG}`);
  await page.getByLabel('Email').fill('sam@localhost');
  await page.getByLabel(/^Name/).fill('Sam');
  await submit(page);
  await expect(page.getByLabel('Email')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel(/^Name/)).toHaveValue('Sam');
  await page.screenshot({ path: `${SHOTS}/waitlist-public-error.png` });
});

test('join, confirm by email, share a link, and move up', async ({ page, browser }) => {
  const problems = watch(page);
  await page.goto(`/w/${SLUG}`);
  await page.getByLabel('Email').fill('first@example.com');
  await submit(page);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/waitlist-public-check-email.png` });

  await page.goto(await confirmLinkFor(page, 'first@example.com'));
  await page.getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: /You are number/ })).toBeVisible();
  const link = await page.getByLabel('Your link to share').inputValue();
  expect(link).toContain(`/w/${SLUG}?ref=`);
  await page.screenshot({ path: `${SHOTS}/waitlist-public-status.png`, fullPage: true });

  const friend = await (await browser.newContext()).newPage();
  await friend.goto(link);
  await friend.getByLabel('Email').fill('friend@example.com');
  await submit(friend);
  await friend.goto(await confirmLinkFor(friend, 'friend@example.com'));
  await friend.getByRole('button').first().click();
  await friend.context().close();

  await page.reload();
  await expect(page.getByText('1 friend joined with your link.')).toBeVisible();

  await page.goto(`/w/${SLUG}/leaderboard`);
  await expect(page.getByRole('heading', { name: 'Top referrers' })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/waitlist-public-leaderboard.png` });
  expect(problems).toEqual([]);
});

test('the signup API answers with CORS and the embed page has no chrome', async ({ page, request }) => {
  const pre = await request.fetch(`/w/${SLUG}/join`, { method: 'OPTIONS', headers: { origin: 'https://example.org', 'access-control-request-method': 'POST' } });
  expect(pre.headers()['access-control-allow-origin']).toBe('*');
  const res = await request.post(`/w/${SLUG}/join`, { data: { email: 'api@example.com' }, headers: { origin: 'https://example.org' } });
  expect(res.status()).toBe(201);
  expect(await res.json()).toMatchObject({ ok: true, needsConfirm: true });
  const bad = await request.post(`/w/${SLUG}/join`, { data: { email: 'nope' } });
  expect(bad.status()).toBe(400);

  await page.goto(`/w/${SLUG}/embed`);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/waitlist-public-embed.png` });
});

test('the embed script adds the form to a page', async ({ page }) => {
  await page.route('**/host.html', (route) =>
    route.fulfill({ contentType: 'text/html', body: `<!doctype html><title>Host</title><div data-toolshed-waitlist="${SLUG}"></div><script src="http://127.0.0.1:${PORT}/m/waitlist/embed.js"></script>` }),
  );
  await page.goto(`http://127.0.0.1:${PORT}/host.html`);
  const frame = page.frameLocator('iframe[title="Join the waitlist"]');
  await expect(frame.getByLabel('Email')).toBeVisible();
});

test('an unknown waitlist is a plain not found page', async ({ page }) => {
  const res = await page.goto('/w/does-not-exist');
  expect(res?.status()).toBe(404);
});
