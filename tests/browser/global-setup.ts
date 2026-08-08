import { mkdir, writeFile } from "node:fs/promises";

import { Client, Pool } from "pg";

import { assertQaSchema, databaseUrlForSchema, requireDatabaseUrl, runProductionMigrations, seedAccessFixture } from "../qa/postgres.mts";

export default async function globalSetup(): Promise<void> {
  const schema = process.env.QA_BROWSER_SCHEMA?.trim() || "qa_browser";
  assertQaSchema(schema);
  const base = requireDatabaseUrl();
  const admin = new Client({ connectionString: base });
  await admin.connect();
  try {
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  const url = databaseUrlForSchema(base, schema);
  let tokens: Record<string, string>;
  try {
    await runProductionMigrations(url);
    const pool = new Pool({ connectionString: url });
    try {
      tokens = await seedAccessFixture(pool, true);
    } finally {
      await pool.end();
    }
  } catch (error) {
    const cleanup = new Client({ connectionString: base });
    await cleanup.connect();
    try {
      await cleanup.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await cleanup.end();
    }
    throw error;
  }

  await mkdir("test-results/auth", { recursive: true });
  for (const role of ["user", "premium", "owner", "admin"] as const) {
    const tokenKey = role === "user" ? "regular" : role;
    await writeFile(`test-results/auth/${role}.json`, JSON.stringify({
      cookies: [{ name: "dnd_firegory_session", value: tokens[tokenKey], domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }],
      origins: [],
    }));
  }
}
