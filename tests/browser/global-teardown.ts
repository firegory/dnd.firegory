import { Client } from "pg";

import { rm } from "node:fs/promises";

import { assertQaDatabase, requireDatabaseUrl } from "../qa/postgres.mts";

export default async function globalTeardown(): Promise<void> {
  const databaseName = process.env.QA_BROWSER_DATABASE?.trim() || "qa_browser";
  assertQaDatabase(databaseName);
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()", [databaseName]);
    await client.query(`DROP DATABASE IF EXISTS ${databaseName}`);
  } finally {
    await client.end();
    await rm("/tmp/dnd-firegory-qa-auth", { recursive: true, force: true });
    await rm("/tmp/dnd-firegory-qa-storage", { recursive: true, force: true });
  }
}
