/**
 * Shared steps for the signed-in product walkthroughs: switching a module on, watching a page for
 * trouble, and taking the three standard screenshots (desktop light, desktop dark, 375 px wide).
 */
import { expect, type Page } from '@playwright/test';

export interface Watch {
  /** Console errors, uncaught errors, failed requests and 5xx answers seen so far. */
  problems: string[];
}

/**
 * Collect anything that should never happen on a healthy page. A 4xx answer to a page the test
 * asked for on purpose (a 404 check, a refused form) is not counted, but a script, style sheet,
 * image or background request that fails is.
 */
export function watch(page: Page): Watch {
  const w: Watch = { problems: [] };
  page.on('console', (m) => {
    // Chrome logs every 4xx answer as a console error, a refused form page included. The response
    // listener below already counts the ones that matter, so these lines are not repeated here.
    if (m.type() === 'error' && !/^Failed to load resource: the server responded with a status of 4\d\d/.test(m.text())) w.problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => w.problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => {
    // A navigation that is replaced by another one is cancelled by the browser, not broken.
    if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) w.problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on('response', (r) => {
    const type = r.request().resourceType();
    if (r.status() >= 500 || (r.status() >= 400 && type !== 'document')) w.problems.push(`${r.status()} ${type}: ${r.url()}`);
  });
  return w;
}

/** Switch a module on for the signed-in workspace, through the Modules screen. Safe to repeat. */
export async function enableModule(page: Page, id: string): Promise<void> {
  await page.goto(`/app/modules/${id}`);
  const on = page.getByRole('button', { name: /^Turn on/ });
  if (await on.count()) {
    await on.first().click();
    await expect(page.getByRole('button', { name: /^Turn off/ }).first()).toBeVisible();
  }
}

/** No sideways scroll: the page is never wider than the window. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  const wide = await page.evaluate<number>('document.documentElement.scrollWidth - window.innerWidth');
  expect(wide, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}

/**
 * Screenshots of the current page as it is: desktop light, desktop dark and 375 px wide. The page
 * is put back as it was. At 375 px it also checks there is no sideways scroll.
 */
export async function shoot(page: Page, product: string, name: string): Promise<void> {
  const base = `.shots/e2e/${product}/${name}`;
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.emulateMedia({ colorScheme: 'light' });
  await page.screenshot({ path: `${base}-light.png`, fullPage: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  const was = await page.evaluate<string | null>(
    "(() => { const r = document.documentElement; const b = r.getAttribute('data-theme'); r.setAttribute('data-theme', 'dark'); return b; })()",
  );
  await page.screenshot({ path: `${base}-dark.png`, fullPage: true });
  await page.evaluate(
    `(() => { const r = document.documentElement; const b = ${JSON.stringify(was)}; if (b === null) r.removeAttribute('data-theme'); else r.setAttribute('data-theme', b); })()`,
  );
  await page.emulateMedia({ colorScheme: 'light' });
  const narrow = await page.context().newPage();
  try {
    await narrow.setViewportSize({ width: 375, height: 800 });
    await narrow.goto(page.url());
    await narrow.screenshot({ path: `${base}-375.png`, fullPage: true });
    await expectNoSideScroll(narrow);
  } finally {
    await narrow.close();
  }
  await page.setViewportSize(size);
}
