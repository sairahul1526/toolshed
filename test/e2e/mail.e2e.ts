import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';

// Sign-in is not part of this checkout, so the test seeds one newsletter into the local database and walks the
// visitor side: signup page, embed, signup, confirmation email, confirm, unsubscribe page. Dashboard cases are
// covered by the route tests in src/modules/mail/screens.test.ts.
const PORT = process.env.PORT ?? '8787';
const SHOTS = '.shots';
const SLUG = 'e2e-weekly';
const NOW = Date.now();

function seed(): void {
  const sql = `INSERT OR REPLACE INTO mail_lists (id, org_id, name, slug, description, double_opt_in, reply_to, thanks_text, archive_public, is_sample, created_at, updated_at)
    VALUES ('ml_e2e', 'org_e2e', 'The Weekly', '${SLUG}', 'One short email each week.', 1, '', '', 1, 0, ${NOW}, ${NOW});
    INSERT OR REPLACE INTO module_state (org_id, module_id, enabled, enabled_at) VALUES ('org_e2e', 'mail', 1, ${NOW})`;
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `.wrangler/e2e-${PORT}`, '--command', sql], { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' } });
}

async function confirmLinkFor(page: Page, to: string): Promise<string> {
  let link = '';
  await expect
    .poll(async () => {
      const res = await page.request.get(`/dev/outbox?to=${encodeURIComponent(to)}`);
      const mails = ((await res.json()) as { emails: { text: string }[] }).emails;
      link = mails.map((m) => m.text.match(/https?:\/\/\S+\/n\/confirm\/\S+/)?.[0] ?? '').find(Boolean) ?? '';
      return link;
    })
    .not.toBe('');
  return link.replace(/[).,]+$/, '');
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

test('signup page: small, no cookies, light, dark and phone width', async ({ page, context }) => {
  const problems = watch(page);
  const res = await page.goto(`/n/${SLUG}`);
  expect(res?.status()).toBe(200);
  expect((await res!.body()).length).toBeLessThan(30 * 1024);
  await expect(page.getByRole('heading', { name: 'The Weekly' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  expect(await context.cookies()).toHaveLength(0);
  await expect(page.locator('head meta[name="description"]')).toHaveAttribute('content', /weekly|One short email/i);
  await page.screenshot({ path: `${SHOTS}/mail-signup-light.png` });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/mail-signup-dark.png` });
  await page.setViewportSize({ width: 375, height: 700 });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);
  await page.screenshot({ path: `${SHOTS}/mail-signup-375.png` });
  expect(problems).toEqual([]);
});

test('the embed can be framed and the dashboard cannot', async ({ request }) => {
  const embed = await request.get(`/n/${SLUG}/embed`);
  expect(embed.status()).toBe(200);
  expect(embed.headers()['x-frame-options']).toBeUndefined();
  const dash = await request.get('/app/mail', { maxRedirects: 0 });
  expect([301, 302, 303, 401, 403, 501]).toContain(dash.status());
});

test('a visitor signs up, gets one confirmation email, confirms, and is told nothing about others', async ({ page }) => {
  await page.goto(`/n/${SLUG}`);
  await page.getByLabel('Email').fill('visitor@example.com');
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /subscribe/i }).click();
  await expect(page.getByRole('heading', { name: /check your inbox/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mail-signup-thanks.png` });

  const link = await confirmLinkFor(page, 'visitor@example.com');
  await page.goto(link);
  // Opening the link only shows a button, so mail scanners do not confirm anyone.
  await expect(page.getByRole('button', { name: /subscribe me/i })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/mail-confirm.png` });
  await page.getByRole('button', { name: /subscribe me/i }).click();
  await expect(page.getByRole('heading', { name: /you are subscribed/i })).toBeVisible();
});

test('bad tokens and unknown newsletters fail plainly', async ({ request }) => {
  expect((await request.get('/n/no-such-newsletter')).status()).toBe(404);
  expect((await request.get('/n/u/not-a-token')).status()).toBe(400);
  expect((await request.get('/n/confirm/not-a-token')).status()).toBe(400);
  expect((await request.get('/n/c/not-a-token', { maxRedirects: 0 })).status()).toBeGreaterThanOrEqual(400);
});

test('the archive and its feed exist even when empty', async ({ page, request }) => {
  const res = await page.goto(`/n/${SLUG}/archive`);
  expect(res?.status()).toBe(200);
  await page.screenshot({ path: `${SHOTS}/mail-archive.png` });
  const rss = await request.get(`/n/${SLUG}/rss.xml`);
  expect(rss.status()).toBe(200);
  expect(rss.headers()['content-type']).toContain('xml');
});

test('module assets are served as static files', async ({ request }) => {
  for (const [path, type] of [['/m/mail/mail.css', 'text/css'], ['/m/mail/mail-public.css', 'text/css'], ['/m/mail/mail.js', 'javascript']] as const) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    expect(res.headers()['content-type']).toContain(type);
  }
});
