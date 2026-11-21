import { defineConfig, devices } from "@playwright/test";

// End-to-end tests for the password-hashing demo page (spikes/hash). Run with `npm run test:e2e:hash`.
export default defineConfig({
  testDir: "test/e2e",
  testMatch: "hash-demo.e2e.ts",
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  use: { baseURL: "http://127.0.0.1:8798", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run demo:hash",
    url: "http://127.0.0.1:8798/results",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
