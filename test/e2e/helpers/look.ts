/**
 * Looks at a page the way the checklist asks: on a phone in dark mode and on a desktop in light
 * mode. Reports sideways scrolling and script errors, and saves a picture of each to `.shots/`
 * (never in git). The page is left the size and colour it was.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page } from '@playwright/test';

const SHOTS = join('.shots', 'auth');
const PHONE = { width: 375, height: 812 };
const DESKTOP = { width: 1280, height: 800 };

/**
 * Chrome logs every 4xx answer as a console error. Pages such as "Too many tries" answer that
 * way on purpose, so those lines are not problems.
 */
const EXPECTED = /Failed to load resource/;

// Scripts for the page are written as text: the project does not load the browser's types.
const sideways = (page: Page) => page.evaluate<number>('document.documentElement.scrollWidth - document.documentElement.clientWidth');
const themeOf = (page: Page) => page.evaluate<string | null>("document.documentElement.getAttribute('data-theme')");
const paint = (page: Page, theme: string | null) =>
  page.evaluate(theme ? `document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})` : "document.documentElement.removeAttribute('data-theme')");

/** Problems with the page as it stands now, in plain words. Empty when there are none. */
export async function inspect(page: Page, name: string): Promise<string[]> {
  mkdirSync(SHOTS, { recursive: true });
  const problems: string[] = [];
  const size = page.viewportSize() ?? DESKTOP;
  const theme = await themeOf(page);

  for (const [label, viewport, colour] of [
    ['375-dark', PHONE, 'dark'],
    ['desktop-light', DESKTOP, 'light'],
  ] as const) {
    await page.setViewportSize(viewport);
    await paint(page, colour);
    const extra = await sideways(page);
    if (extra > 0) problems.push(`${name} scrolls sideways by ${extra}px at ${viewport.width}px wide`);
    // Colours fade when the theme flips; without this the picture catches them half way.
    await page.screenshot({ path: join(SHOTS, `${name}-${label}.png`), fullPage: true, animations: 'disabled' });
  }
  await page.setViewportSize(size);
  await paint(page, theme);

  for (const message of await page.consoleMessages()) {
    if (message.type() === 'error' && !EXPECTED.test(message.text())) problems.push(`${name} logged an error: ${message.text()}`);
  }
  for (const error of await page.pageErrors()) problems.push(`${name} threw: ${error.message}`);
  return problems;
}

/** Fail the test when the page scrolls sideways or logged an error. */
export async function look(page: Page, name: string): Promise<void> {
  expect(await inspect(page, name)).toEqual([]);
}
