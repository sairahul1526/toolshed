/**
 * Helpers for the signed-in dashboard screen tests: collect console errors and failed requests,
 * save screenshots under `.shots/e2e/`, and check a page does not scroll sideways.
 */
import { mkdirSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

const SHOTS = '.shots/e2e';

export interface Watch {
  /** Console errors and failed requests seen so far, in plain words. */
  problems: string[];
  /** Fail the test when anything went wrong. `allow` ignores problems that contain one of the strings. */
  expectClean(allow?: string[]): void;
}

/** Start listening. Responses with a status of 400 or more count as failed, so allow the ones a test causes on purpose. */
export function watch(page: Page): Watch {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => {
    if (r.status() >= 400) problems.push(`response ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  return {
    problems,
    expectClean(allow = []) {
      expect(problems.filter((p) => !allow.some((a) => p.includes(a)))).toEqual([]);
    },
  };
}

/**
 * Save `.shots/e2e/<name>.png` of the whole page. The window is made as tall as the page for the
 * picture, because a full-page capture re-lays out the fixed sidebar and smears it over the content.
 */
export async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  const size = page.viewportSize() ?? { width: 1280, height: 800 };
  const height = await page.evaluate<number>('document.documentElement.scrollHeight');
  await page.setViewportSize({ width: size.width, height: Math.min(Math.max(height, size.height), 4000) });
  await page.waitForTimeout(350); // the sidebar and dialogs animate after a resize
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
  await page.setViewportSize(size);
}

/** Save what is in the window right now (use this for an open dialog). */
export async function shotView(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Put the page in light or dark the way the moon button does, then wait for the colours to settle. */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(`document.documentElement.setAttribute('data-theme', '${theme}')`);
  await page.waitForTimeout(100);
}

/** Desktop light, desktop dark and 375 px wide, in that order, then back to desktop light. */
export async function shotThemes(page: Page, name: string): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await setTheme(page, 'light');
  await shot(page, `${name}-desktop-light`);
  await setTheme(page, 'dark');
  await shot(page, `${name}-desktop-dark`);
  await setTheme(page, 'light');
  await page.setViewportSize({ width: 375, height: 800 });
  await shot(page, `${name}-375`);
  await expectNoSideScroll(page);
  await page.setViewportSize({ width: 1280, height: 800 });
}

/** The page is no wider than the window, so nothing needs a sideways scroll. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  const over = await page.evaluate('document.documentElement.scrollWidth - document.documentElement.clientWidth');
  expect(over, 'the page scrolls sideways').toBeLessThanOrEqual(0);
}
