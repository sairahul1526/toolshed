import { expect, test } from "@playwright/test";

test("the app boots and answers health checks", async ({ request }) => {
  const res = await request.get("/healthz");
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test("unknown pages get a 404 page, unknown API paths a JSON error", async ({ page, request }) => {
  const res = await page.goto("/definitely-not-here");
  expect(res?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

  const api = await request.get("/api/v1/definitely-not-here");
  expect(api.status()).toBe(401);
  expect(await api.json()).toMatchObject({ code: "unauthorized" });
});

test("the dev outbox is reachable in dev mode", async ({ request }) => {
  const res = await request.get("/dev/outbox");
  expect(res.status()).toBe(200);
  expect(await res.json()).toHaveProperty("emails");
});
