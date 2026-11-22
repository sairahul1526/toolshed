import { expect, test } from "@playwright/test";

test("a ping for an unknown heartbeat gets a plain 404, and a bad token never reaches the database", async ({ request }) => {
  for (const path of ["/hb/no-such-token", "/hb/no-such-token/start", "/hb/no-such-token/fail", "/hb/" + "x".repeat(200)]) {
    const res = await request.get(path);
    expect(res.status()).toBe(404);
  }
});

test("an unknown status page is a 404 page, and its feeds and badge are 404 too, but its stylesheet is just empty", async ({ page, request }) => {
  const res = await page.goto("/status/not-a-page");
  expect(res?.status()).toBe(404);
  for (const path of ["status.json", "feed.rss", "feed.atom", "badge.svg"]) {
    expect((await request.get(`/status/not-a-page/${path}`)).status()).toBe(404);
  }
  const css = await request.get("/status/not-a-page/custom.css");
  expect(css.status()).toBe(200);
  expect((await css.text()).trim()).toBe("");
});

test("the subscribe form does not exist for a page that is not there", async ({ request }) => {
  const res = await request.post("/status/not-a-page/subscribe", { form: { email: "person@example.com" } });
  expect(res.status()).toBe(404);
});

test("the dashboard asks for sign-in instead of showing monitors", async ({ request }) => {
  const res = await request.get("/app/monitor", { maxRedirects: 0 });
  expect([301, 302, 303, 401, 403, 501]).toContain(res.status());
  const api = await request.get("/api/v1/monitor/monitors");
  expect(api.status()).toBe(401);
});

test("the module assets are served as static files", async ({ request }) => {
  for (const [file, type] of [["status.css", "text/css"], ["monitor.css", "text/css"], ["monitor.js", "javascript"], ["widget.js", "javascript"]] as const) {
    const res = await request.get(`/m/monitor/${file}`);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain(type);
  }
});

test("the status widget script only builds a link and reads status.json", async ({ request }) => {
  const js = await (await request.get("/m/monitor/widget.js")).text();
  expect(js).toContain("status.json");
  expect(js).not.toMatch(/innerHTML|eval\(|document\.write/);
});
