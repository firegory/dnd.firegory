import { Client } from "pg";

import { assertQaSchema, requireDatabaseUrl } from "../qa/postgres.mts";

export default async function globalTeardown(): Promise<void> {
  const schema = process.env.QA_BROWSER_SCHEMA?.trim() || "qa_browser";
  assertQaSchema(schema);
  const client = new Client({ connectionString: requireDatabaseUrl() });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await client.end();
  }
}
