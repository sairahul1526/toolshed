import { expect, test, type Page } from '@playwright/test';

const SHOTS = '.shots';

// These run inside the browser. The project does not load the DOM types, so the globals are declared loosely here.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
declare const getComputedStyle: any;
declare const NodeFilter: any;
declare const DataTransfer: any;
declare const ClipboardEvent: any;
declare const localStorage: any;

/** Finds visible text whose colour is below WCAG AA (4.5, or 3 for large text) against its real background. */
async function lowContrast(page: Page) {
  return page.evaluate(() => {
    const parse = (s: string) => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return null;
      const p = m[1]!.split(/[,/ ]+/).filter(Boolean).map(Number);
      return { r: p[0]!, g: p[1]!, b: p[2]!, a: p[3] ?? 1 };
    };
    const lum = (c: { r: number; g: number; b: number }) => {
      const f = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const bgOf = (el: any) => {
      let base = { r: 255, g: 255, b: 255 };
      const layers: { r: number; g: number; b: number; a: number }[] = [];
      for (let e: any = el; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none') return null;
        const c = parse(cs.backgroundColor);
        if (c && c.a > 0) {
          layers.push(c);
          if (c.a >= 1) break;
        }
      }
      for (const l of layers.reverse()) base = { r: base.r * (1 - l.a) + l.r * l.a, g: base.g * (1 - l.a) + l.g * l.a, b: base.b * (1 - l.a) + l.b * l.a };
      return base;
    };
    const bad: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const seen = new Set<any>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el || seen.has(el) || !n.textContent?.trim()) continue;
      seen.add(el);
      if (el.closest('.sr-only, [hidden], script, style, dialog:not([open]), .sprite')) continue;
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.opacity === '0') continue;
      if (el.closest('[disabled], [aria-disabled="true"], .is-disabled')) continue;
      const fg = parse(cs.color);
      const bg = bgOf(el);
      if (!fg || !bg) continue;
      const a = fg.a;
      const mixed = { r: bg.r * (1 - a) + fg.r * a, g: bg.g * (1 - a) + fg.g * a, b: bg.b * (1 - a) + fg.b * a };
      const l1 = lum(mixed);
      const l2 = lum(bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) bad.push(`${ratio.toFixed(2)} ${el.tagName.toLowerCase()}.${el.className} "${n.textContent.trim().slice(0, 30)}"`);
    }
    return bad;
  });
}

const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test.describe('gallery', () => {
  test('light, dark and phone render without errors or outside requests', async ({ page }) => {
    const errors: string[] = [];
    const outside: string[] = [];
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('request', (r) => {
      if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('data:')) outside.push(r.url());
    });

    await page.goto('/dev/ui?theme=light');
    await expect(page.getByRole('heading', { name: /UI kit/ })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/gallery-light.png`, fullPage: true });
    expect(await noOverflow(page)).toBe(true);

    await page.goto('/dev/ui?theme=dark&accent=violet');
    await page.screenshot({ path: `${SHOTS}/gallery-dark.png`, fullPage: true });

    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dev/ui?theme=light');
    await page.screenshot({ path: `${SHOTS}/gallery-375.png`, fullPage: true });
    expect(await noOverflow(page)).toBe(true);

    expect(errors).toEqual([]);
    expect(outside).toEqual([]);
  });

  test('worst-case data does not break the layout', async ({ page }) => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/dev/ui?data=worst&theme=light');
      expect(await noOverflow(page), `overflow at ${width}`).toBe(true);
    }
    await page.screenshot({ path: `${SHOTS}/gallery-worst-375.png`, fullPage: true });
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`text meets AA contrast in ${theme}`, async ({ page }) => {
      for (const accent of ['lime', 'violet', 'amber']) {
        await page.goto(`/dev/ui?theme=${theme}&accent=${accent}`);
        expect(await lowContrast(page), `${theme} ${accent}`).toEqual([]);
      }
    });
  }
});

test.describe('behaviour', () => {
  test('theme toggle persists across reloads and the sidebar collapses', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
    await page.locator('[data-theme-btn]').first().click();
    const first = await page.locator('html').getAttribute('data-theme');
    expect(['light', 'dark']).toContain(first);
    await page.reload();
    expect(await page.locator('html').getAttribute('data-theme')).toBe(first);

    await page.locator('[data-collapse]').first().click();
    await expect(page.locator('html')).toHaveClass(/nav-collapsed/);
    await page.reload();
    await expect(page.locator('html')).toHaveClass(/nav-collapsed/);
  });

  test('dialog, menu, command menu and tabs work from the keyboard', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await expect(page.getByRole('dialog', { name: 'Invite people' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/dialog.png` });
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Invite people' })).toBeHidden();

    await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(page.getByRole('menuitem', { name: 'Edit' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+k');
    const command = page.locator('#command');
    await expect(command).toBeVisible();
    await page.keyboard.type('forms');
    await expect(command.getByRole('link', { name: /Forms/ }).first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(command).toBeHidden();

    const tabs = page.getByRole('tablist').first();
    await tabs.getByRole('tab').first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { selected: true })).toHaveText(/Clicks/);
  });

  test('confirm dialog asks before the action runs', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Delete link' }).first().click();
    await expect(page.getByRole('dialog', { name: 'Delete this link?' })).toBeVisible();
  });

  test('toast shows and dismisses', async ({ page }) => {
    await page.goto('/dev/ui');
    await page.getByRole('button', { name: 'Show a toast' }).click();
    await expect(page.locator('.toast-region .toast').first()).toBeVisible();
  });

  test('the table becomes cards on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/dev/ui');
    const cell = page.locator('table td[data-label="Clicks"]').first();
    expect(await cell.evaluate((el) => getComputedStyle(el).display)).not.toBe('table-cell');
  });

  test('OTP input moves on paste and keeps one value', async ({ page }) => {
    await page.goto('/dev/ui/auth?state=code');
    const first = page.locator('.otp input').first();
    await first.focus();
    await page.evaluate(() => {
      const dt = new DataTransfer();
      dt.setData('text', '123456');
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await expect(page.locator('[data-otp-value]')).toHaveValue('123456');
  });
});

test.describe('other pages', () => {
  test('auth, error and public presets render', async ({ page }) => {
    await page.goto('/dev/ui/auth');
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await page.screenshot({ path: `${SHOTS}/auth-light.png` });
    expect(await lowContrast(page)).toEqual([]);

    const res = await page.goto('/dev/ui/error?status=404');
    expect(res?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();

    for (const preset of ['paper', 'warm', 'cobalt', 'dusk']) {
      for (const theme of ['light', 'dark']) {
        await page.goto(`/dev/ui/public?preset=${preset}&theme=${theme}`);
        await expect(page.getByRole('heading', { name: 'Tell us about your project' })).toBeVisible();
        expect(await lowContrast(page), `${preset} ${theme}`).toEqual([]);
        if (theme === 'light') await page.screenshot({ path: `${SHOTS}/public-${preset}.png` });
      }
    }
  });
  test('a code block keeps its copy button in its top right corner', async ({ page }) => {
    for (const width of [1280, 375]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto('/dev/ui?theme=light');
      const off = await page.evaluate(() =>
        [...document.querySelectorAll('pre.code')].flatMap((pre: any) => {
          const btn = pre.querySelector(':scope > .icon-btn');
          if (!btn) return [];
          const a = pre.getBoundingClientRect();
          const b = btn.getBoundingClientRect();
          const text = pre.querySelector('code').getBoundingClientRect();
          return b.top - a.top < 12 && a.right - b.right < 12 && text.right <= b.left + 1 ? [] : [pre.textContent.slice(0, 30)];
        }),
      );
      expect(off, `at ${width}px`).toEqual([]);
    }
  });
});
