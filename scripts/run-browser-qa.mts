import { spawn } from "node:child_process";

import { Client } from "pg";

import { assertQaDatabase, requireDatabaseUrl } from "../tests/qa/postgres.mts";

const databaseName = process.env.QA_BROWSER_DATABASE?.trim() || "qa_browser";
assertQaDatabase(databaseName);

const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
  const child = spawn(process.execPath, ["node_modules/@playwright/test/cli.js", "test"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});

// Playwright owns the production webServer and closes it before its process
// exits. Database cleanup here cannot terminate an active server connection.
const admin = new Client({ connectionString: requireDatabaseUrl() });
await admin.connect();
try {
  await admin.query(`DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`);
} finally {
  await admin.end();
}

if (result.code !== 0) {
  throw new Error(`Browser QA failed (${result.signal ?? result.code}).`);
}
