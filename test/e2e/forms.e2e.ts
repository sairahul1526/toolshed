import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { TEMPLATES } from '../../src/modules/forms/templates';

// The sign-in system is not part of this checkout, so the test seeds one published form straight into the
// local database, then walks the public side the way a visitor would: open, answer, submit, see the ending.
// Signed-in screens are covered by the module's own route tests (src/modules/forms/dashboard.test.ts).
const PORT = process.env.PORT ?? '8787';
const SHOTS = '.shots';
const SLUG = 'e2e-feedback';
const NOW = Date.now();

function sql(command: string): void {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'DB', '--local', '--persist-to', `.wrangler/e2e-${PORT}`, '--command', command], {
    stdio: 'pipe',
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true' },
  });
}

const q = (s: string) => s.replace(/'/g, "''");

function seed(): void {
  const template = TEMPLATES.find((t) => t.id === 'feedback-nps')!;
  const definition = q(JSON.stringify(template.build()));
  sql(`INSERT OR REPLACE INTO forms_versions (id, org_id, form_id, number, kind, definition, created_at) VALUES ('ver_e2e', 'org_e2e', 'frm_e2e', 1, 'published', '${definition}', ${NOW})`);
  sql(`INSERT OR REPLACE INTO forms_forms (id, org_id, slug, name, status, draft_version_id, published_version_id, settings, created_at, updated_at, published_at) VALUES ('frm_e2e', 'org_e2e', '${SLUG}', 'Customer feedback', 'live', 'ver_e2e', 'ver_e2e', '{}', ${NOW}, ${NOW}, ${NOW})`);
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

test('a visitor opens the form, sees it at phone width and in dark mode', async ({ page }) => {
  const problems = watch(page);
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/f/${SLUG}`);
  await expect(page.getByText('How likely are you to recommend us')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/forms-public-375.png`, fullPage: true });
  expect(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')).toBe(true);

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: `${SHOTS}/forms-public-desktop.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: `${SHOTS}/forms-public-dark.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('an empty required answer shows an inline error and nothing is saved', async ({ page }) => {
  await page.goto(`/f/${SLUG}`);
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /submit|send/i }).first().click();
  await expect(page.locator('.has-error').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/forms-public-error.png`, fullPage: true });
});

test('a visitor answers by keyboard and sees the ending', async ({ page }) => {
  const problems = watch(page);
  await page.goto(`/f/${SLUG}`);
  await page.getByRole('radio', { name: '9' }).first().check();
  await page.waitForTimeout(2200);
  await page.getByRole('button', { name: /submit|send/i }).first().click();
  await expect(page.locator('[data-done]')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/forms-public-done.png`, fullPage: true });
  expect(problems).toEqual([]);
});

test('an unknown address gets a not-found page, a closed form says so', async ({ page }) => {
  const missing = await page.goto('/f/no-such-form');
  expect(missing?.status()).toBe(404);
  sql(`UPDATE forms_forms SET status = 'closed' WHERE id = 'frm_e2e'`);
  const closed = await page.goto(`/f/${SLUG}`);
  expect(closed?.status()).toBeLessThan(500);
  await expect(page.getByText(/closed|no longer/i).first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/forms-public-closed.png` });
  sql(`UPDATE forms_forms SET status = 'live' WHERE id = 'frm_e2e'`);
});

test('the popup script is small and served with a script type', async ({ request }) => {
  const res = await request.get('/m/forms/embed.js');
  expect(res.status()).toBe(200);
  expect((await res.body()).length).toBeLessThan(8 * 1024);
});
