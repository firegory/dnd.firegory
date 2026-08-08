import { defineConfig, devices } from "@playwright/test";

import { databaseUrlForDatabase, requireDatabaseUrl } from "./tests/qa/postgres.mts";

const port = 3100;
const baseURL = `http://127.0.0.1:${port}`;
const databaseName = process.env.QA_BROWSER_DATABASE?.trim() || "qa_browser";
const databaseUrl = databaseUrlForDatabase(requireDatabaseUrl(), databaseName);
const authRoot = "/tmp/dnd-firegory-qa-auth";

export default defineConfig({
  testDir: "./tests/browser",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "line",
  outputDir: "test-results/results",
  globalSetup: "./tests/browser/global-setup.ts",
  globalTeardown: "./tests/browser/global-teardown.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "anonymous", grep: /@anonymous/, use: { ...devices["Desktop Chrome"] } },
    { name: "user", grep: /@user/, use: { ...devices["Desktop Chrome"], storageState: `${authRoot}/user.json` } },
    { name: "no-access", grep: /@no-access/, use: { ...devices["Desktop Chrome"], storageState: `${authRoot}/empty.json` } },
    { name: "premium", grep: /@premium/, use: { ...devices["Desktop Chrome"], storageState: `${authRoot}/premium.json` } },
    { name: "owner", grep: /@owner/, use: { ...devices["Desktop Chrome"], storageState: `${authRoot}/owner.json` } },
    { name: "admin", grep: /@admin/, use: { ...devices["Desktop Chrome"], storageState: `${authRoot}/admin.json` } },
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
      STORAGE_ROOT: "/tmp/dnd-firegory-qa-storage",
    },
  },
});
