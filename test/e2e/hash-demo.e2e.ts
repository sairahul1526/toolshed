import { expect, test } from "@playwright/test";

// Feature #1 demo page (spikes/hash/demo): results table, hash, verify, errors, theme.

test("shows the measured settings with the pick highlighted", async ({ page }) => {
  await page.goto("/");
  const rows = page.locator("#rows tr");
  await expect(rows).toHaveCount(12);
  const pick = page.locator("#rows tr.pick");
  await expect(pick).toContainText("PBKDF2-SHA256, 50,000");
  await expect(pick).toContainText("Fits");
  await expect(page.locator("#rows tr", { hasText: "Better Auth default, as shipped" })).toContainText("Over");
});

test("hashes a password, then matches and rejects", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.locator("#stored")).toHaveText(/^pbkdf2-sha256\$50000\$[\w-]{22}\$[\w-]{43}$/);

  const check = page.getByLabel("Check a password against it");
  await check.fill("correct horse battery staple");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator("#verdict")).toHaveText("Matches");

  await check.fill("wrong horse");
  await page.getByRole("button", { name: "Check" }).click();
  await expect(page.locator("#verdict")).toHaveText("Doesn’t match");

  // A new hash clears the old verdict.
  await page.getByLabel("Iterations").selectOption("10000");
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.locator("#stored")).toHaveText(/^pbkdf2-sha256\$10000\$/);
  await expect(page.locator("#verdict")).toHaveText("");
});

test("shows plain errors for empty and over-long passwords", async ({ page }) => {
  await page.goto("/");
  const pw = page.getByLabel("Password", { exact: true });
  await pw.fill("");
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.getByRole("alert")).toHaveText("Enter a password.");
  await expect(page.locator("#verifyform")).toBeHidden();

  await pw.fill("🔑".repeat(257));
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.getByRole("alert")).toHaveText("Passwords can be up to 256 characters.");

  await pw.fill("🔑".repeat(256));
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(page.locator("#stored")).toHaveText(/^pbkdf2-sha256\$/);
});

test("API refuses bad bodies with a stable code", async ({ request }) => {
  const res = await request.post("/api/hash", { data: "not json", headers: { "content-type": "application/json" } });
  expect(res.status()).toBe(400);
  expect(await res.json()).toMatchObject({ code: "bad_request" });
  const iter = await request.post("/api/hash", { data: { password: "x", iterations: 5 } });
  expect(iter.status()).toBe(400);
  expect(await iter.json()).toMatchObject({ code: "bad_iterations" });
  const verify = await request.post("/api/verify", { data: { password: "x", stored: "garbage" } });
  expect(await verify.json()).toEqual({ ok: false });
});

test("theme button switches between light and dark", async ({ page }) => {
  await page.goto("/?theme=light");
  const btn = page.getByRole("button", { name: "Dark mode" });
  await btn.click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.getByRole("button", { name: "Light mode" })).toBeVisible();
});

test("long input and the stored hash fit a 375 px screen", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  await page.getByLabel("Password", { exact: true }).fill("🔑".repeat(256));
  await page.getByRole("button", { name: "Hash it" }).click();
  await expect(page.locator("#stored")).toHaveText(/^pbkdf2-sha256\$/);
  const overflows = await page.evaluate("document.documentElement.scrollWidth > document.documentElement.clientWidth");
  expect(overflows).toBe(false);
});
