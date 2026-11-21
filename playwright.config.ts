import { defineConfig, devices } from "@playwright/test";

// End-to-end tests run against `wrangler dev` (local workerd) with a fresh database, never a real account.
// PORT picks the port, so several checkouts can run at once.
const port = Number(process.env.PORT ?? 8787);

export default defineConfig({
  testDir: "test/e2e",
  testMatch: "**/*.e2e.ts",
  testIgnore: "**/hash-demo.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: `http://127.0.0.1:${port}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node scripts/e2e-server.mjs",
    url: `http://127.0.0.1:${port}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: { PORT: String(port), WRANGLER_SEND_METRICS: "false" },
  },
});
