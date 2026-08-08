import { defineConfig, devices } from "@playwright/test";

import { databaseUrlForSchema, requireDatabaseUrl } from "./tests/qa/postgres.mts";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const schema = process.env.QA_BROWSER_SCHEMA?.trim() || "qa_browser";
const databaseUrl = databaseUrlForSchema(requireDatabaseUrl(), schema);

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  globalSetup: "./tests/browser/global-setup.ts",
  globalTeardown: "./tests/browser/global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "anonymous", grep: /@anonymous/, use: { ...devices["Desktop Chrome"] } },
    { name: "user", grep: /@user/, use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/user.json" } },
    { name: "premium", grep: /@premium/, use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/premium.json" } },
    { name: "owner", grep: /@owner/, use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/owner.json" } },
    { name: "admin", grep: /@admin/, use: { ...devices["Desktop Chrome"], storageState: "test-results/auth/admin.json" } },
  ],
  webServer: {
    command: `npm run start -- --hostname 127.0.0.1 --port ${port}`,
    url: `${baseURL}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      AUTH_SECRET: "qa-only-auth-secret-with-no-production-value",
      APP_URL: baseURL,
      NEXT_PUBLIC_APP_URL: baseURL,
      DND_DATA_ROOT: "content-repository",
    },
  },
});
