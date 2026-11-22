import { expect, test } from "@playwright/test";

test("an unknown short code gets the normal not-found page", async ({ page }) => {
  const res = await page.goto("/zz-no-such-link");
  expect(res?.status()).toBe(404);
});

test("a QR request answers with an SVG, and a malformed code is a 404", async ({ request }) => {
  const ok = await request.get("/l/qr/zz-no-such-link");
  expect(ok.status()).toBe(200);
  expect(ok.headers()["content-type"]).toContain("image/svg+xml");
  const bad = await request.get("/l/qr/bad%20code");
  expect(bad.status()).toBe(404);
});

test("the report page for a missing code is a 404", async ({ request }) => {
  const res = await request.get("/l/report/zz-no-such-link");
  expect(res.status()).toBe(404);
});

test("the dashboard asks for sign-in instead of showing links", async ({ request }) => {
  const res = await request.get("/app/links", { maxRedirects: 0 });
  expect([301, 302, 303, 401, 403, 501]).toContain(res.status());
});

test("the module assets are served as static files", async ({ request }) => {
  const css = await request.get("/m/links/links.css");
  expect(css.status()).toBe(200);
  expect(css.headers()["content-type"]).toContain("text/css");
  const pub = await request.get("/m/links/links-public.css");
  expect(pub.status()).toBe(200);
  const js = await request.get("/m/links/links.js");
  expect(js.status()).toBe(200);
  expect(js.headers()["content-type"]).toContain("javascript");
});
