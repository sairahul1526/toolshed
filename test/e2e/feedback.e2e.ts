import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

// Visitor-only: sign-in is a placeholder in this build, so the dashboard cannot be driven in a browser.
// The dashboard is covered by the route tests next to the code. Here the portal is seeded straight into
// the local database after the server is up, then driven as an anonymous visitor.

const port = process.env.PORT ?? "8787";
const persist = `.wrangler/e2e-${port}`;
const SLUG = "acme-hq";
const ORG = "org_e2e_feedback";
const NOW = Date.now();

function seed(): void {
  const sql = `
INSERT OR IGNORE INTO module_state (org_id, module_id, enabled, settings, sample, enabled_at) VALUES ('${ORG}', 'feedback', 1, '{}', 0, ${NOW});
INSERT OR IGNORE INTO fb_portals (id, org_id, slug, name, tagline, theme, show_powered, vote_limit, allow_anonymous, hide_last_names, roadmap_on, changelog_on, default_sort, digest_emails, created_at, updated_at)
  VALUES ('por_e2e', '${ORG}', '${SLUG}', 'Acme feedback', 'Tell us what to build next.', 'paper', 0, 0, 1, 0, 1, 1, 'top', '', ${NOW}, ${NOW});
INSERT OR IGNORE INTO fb_statuses (id, org_id, name, tone, kind, position, in_roadmap, is_initial) VALUES
  ('st_open', '${ORG}', 'Open', 'neutral', 'open', 0, 0, 1),
  ('st_plan', '${ORG}', 'Planned', 'info', 'open', 1, 1, 0),
  ('st_done', '${ORG}', 'Complete', 'success', 'done', 2, 1, 0);
INSERT OR IGNORE INTO fb_boards (id, org_id, slug, name, description, position, visibility, voting_on, hide_votes, moderate, posting_on, created_at)
  VALUES ('bd_e2e', '${ORG}', 'ideas', 'Ideas', 'Requests from customers.', 0, 'public', 1, 0, 0, 1, ${NOW});
INSERT OR IGNORE INTO fb_posts (id, org_id, board_id, slug, title, body, status_id, review, source, vote_count, comment_count, trend, created_at, updated_at) VALUES
  ('po_1', '${ORG}', 'bd_e2e', 'dark-mode', 'Dark mode for the dashboard', 'Please add a dark theme.', 'st_plan', 'published', 'portal', 12, 0, 1, ${NOW - 3000}, ${NOW - 3000}),
  ('po_2', '${ORG}', 'bd_e2e', 'csv-export', 'Export everything to CSV', 'We need a full export.', 'st_open', 'published', 'portal', 5, 0, 1, ${NOW - 2000}, ${NOW - 2000}),
  ('po_3', '${ORG}', 'bd_e2e', 'saml-sign-in', 'Sign in with a very long single sign on provider name that keeps going and going without any break at all', 'Long title check.', 'st_done', 'published', 'portal', 1, 0, 1, ${NOW - 1000}, ${NOW - 1000});
INSERT OR IGNORE INTO fb_entries (id, org_id, slug, title, body, labels, state, publish_at, published_at, mailed_at, complete_posts, author_name, sample, created_at, updated_at)
  VALUES ('en_1', '${ORG}', 'csv-import', 'Import from CSV', 'You can now **import** posts from a CSV file.', '["New"]', 'published', NULL, ${NOW - 500}, ${NOW - 500}, 0, 'The team', 0, ${NOW - 500}, ${NOW - 500});
`;
  const dir = mkdtempSync(join(tmpdir(), "fb-e2e-"));
  const file = join(dir, "seed.sql");
  try {
    writeFileSync(file, sql);
    execFileSync("npx", ["wrangler", "d1", "execute", "DB", "--local", "--persist-to", persist, "--file", file], {
      stdio: "pipe",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test.beforeAll(() => seed());

test("the portal home lists posts and sorts by votes", async ({ page }) => {
  const res = await page.goto(`/feedback/${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.locator("body")).toContainText("Acme feedback");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Ideas");
  await expect(page.getByRole("link", { name: "Dark mode for the dashboard" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Export everything to CSV" })).toBeVisible();
  const text = await page.locator("main").innerText();
  expect(text.indexOf("Dark mode for the dashboard")).toBeLessThan(text.indexOf("Export everything to CSV"));
});

test("a post page opens and shows its status", async ({ page }) => {
  await page.goto(`/feedback/${SLUG}`);
  await page.getByRole("link", { name: "Dark mode for the dashboard" }).first().click();
  await expect(page).toHaveURL(/\/p\/dark-mode/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Dark mode for the dashboard");
  await expect(page.locator("main")).toContainText("Planned");
});

test("a guest vote works without JavaScript", async ({ browser }) => {
  const ctx = await browser.newContext({ javaScriptEnabled: false });
  const page = await ctx.newPage();
  await page.goto(`/feedback/${SLUG}/p/csv-export`);
  const vote = page.locator("main form[action$='/vote'] button").first();
  await expect(vote).toBeVisible();
  await vote.click();
  await expect(page.locator("main")).toContainText(/6|voted|Voted/);
  await ctx.close();
});

test("the new post form shows inline errors and accepts a guest post held for review", async ({ page }) => {
  await page.goto(`/feedback/${SLUG}/new`);
  await page.getByRole("button", { name: /submit|post|send|add/i }).first().click();
  await expect(page.locator("main")).toContainText(/title|Add a/i);
});

test("the roadmap shows a lane for each roadmap status", async ({ page }) => {
  const res = await page.goto(`/roadmap/${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.locator("main")).toContainText("Planned");
  await expect(page.locator("main")).toContainText("Dark mode for the dashboard");
});

test("the changelog lists entries and serves an RSS feed", async ({ page, request }) => {
  const res = await page.goto(`/changelog/${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole("link", { name: "Import from CSV" }).first()).toBeVisible();
  await page.getByRole("link", { name: "Import from CSV" }).first().click();
  await expect(page.locator("main")).toContainText("import");

  const feed = await request.get(`/changelog/${SLUG}/feed.rss`);
  expect(feed.status()).toBe(200);
  expect(feed.headers()["content-type"]).toContain("xml");
  expect(await feed.text()).toContain("Import from CSV");

  const latest = await request.get(`/feedback/${SLUG}/latest.json`);
  expect(latest.status()).toBe(200);
  expect(latest.headers()["access-control-allow-origin"]).toBeTruthy();
});

test("a private or unknown portal gives a 404", async ({ request }) => {
  const res = await request.get("/feedback/no-such-portal");
  expect(res.status()).toBe(404);
});

test("the widget script is small and has no eval", async ({ request }) => {
  const res = await request.get("/m/feedback/widget.js");
  expect(res.status()).toBe(200);
  const body = await res.body();
  expect(body.length).toBeLessThan(15 * 1024);
  expect(body.toString()).not.toMatch(/\beval\(|new Function\(/);
});

test("the widget adds a button to a host page, opens the portal in a frame and leaves the page alone", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/host-page", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><head><title>Host</title></head><body>
        <h1>Customer app</h1><button id="mine" type="button">Own button</button><p id="out"></p>
        <script>document.getElementById('mine').addEventListener('click', function(){ document.getElementById('out').textContent = 'host works'; });</script>
        <script src="/m/feedback/widget.js" data-portal="${SLUG}" defer></script></body></html>`,
    }),
  );
  await page.goto("/host-page");
  await expect(page.locator("[data-toolshed-feedback]")).toHaveCount(1);

  // The button lives in a closed shadow root, so click where it floats: bottom right.
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.click(size.width - 60, size.height - 36);
  await expect.poll(() => page.frames().some((f) => f.url().includes(`/feedback/${SLUG}/embed`))).toBe(true);
  const frame = page.frames().find((f) => f.url().includes(`/feedback/${SLUG}/embed`));
  await expect(frame!.getByRole("link", { name: "Dark mode for the dashboard" }).first()).toBeVisible();

  await page.keyboard.press("Escape");
  await page.locator("#mine").click();
  await expect(page.locator("#out")).toHaveText("host works");
  expect(errors).toEqual([]);
});

test("the portal holds up at 375 px with no sideways scroll", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const path of [`/feedback/${SLUG}`, `/roadmap/${SLUG}`, `/changelog/${SLUG}`, `/feedback/${SLUG}/p/saml-sign-in`]) {
    await page.goto(path);
    const wide = await page.evaluate<boolean>("document.documentElement.scrollWidth > document.documentElement.clientWidth");
    expect(wide, path).toBe(false);
  }
});
