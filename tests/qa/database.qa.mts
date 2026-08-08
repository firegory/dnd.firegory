import assert from "node:assert/strict";
import test from "node:test";

import { CompendiumImportRunService } from "../../src/server/compendium/import-runs.ts";
import { CompendiumNotFoundError, CompendiumReadService } from "../../src/server/compendium/read-service.ts";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";
import { applyMigrationPrefix, IDS, isolatedDatabase, runProductionMigrations, seedAccessFixture } from "./postgres.mts";

test("QA integration: fresh and upgrade production migrations execute on PostgreSQL 16 with pgvector", async (t) => {
  const fresh = await isolatedDatabase("fresh");
  t.after(() => fresh.cleanup());
  await runProductionMigrations(fresh.url);
  const applied = await fresh.pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(applied.rows.map(({ version }) => version), [...MIGRATION_FILENAMES].sort());
  assert.equal((await fresh.pool.query("SELECT '[1,2,3]'::vector(3)")).rowCount, 1);

  const upgrade = await isolatedDatabase("upgrade");
  t.after(() => upgrade.cleanup());
  const client = await upgrade.pool.connect();
  try {
    await applyMigrationPrefix(client, "0010_nfs_content_index_sync.sql");
    await client.query(
      `INSERT INTO users(id,email,password_hash,role) VALUES ($1,'legacy@qa.invalid','legacy','user')`,
      [IDS.users.regular],
    );
  } finally {
    client.release();
  }
  await runProductionMigrations(upgrade.url);
  const upgraded = await upgrade.pool.query<{ count: string }>("SELECT count(*) FROM schema_migrations");
  assert.equal(Number(upgraded.rows[0]?.count), MIGRATION_FILENAMES.length);
  assert.equal((await upgrade.pool.query("SELECT kind FROM compendium_classes LIMIT 0")).rowCount, 0);
  assert.equal((await upgrade.pool.query("SELECT category FROM compendium_glossary LIMIT 0")).rowCount, 0);
});

test("QA integration: live compendium role matrix is source and edition scoped", async (t) => {
  const db = await isolatedDatabase("rbac");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);
  const service = new CompendiumReadService(db.pool);

  const cases = [
    ["anonymous", { role: "user" as const }, ["qa-spell-1"]],
    ["authenticated user", { role: "user" as const, userId: IDS.users.regular }, ["qa-spell-1"]],
    ["premium", { role: "premium" as const, userId: IDS.users.premium }, ["qa-spell-1", "qa-spell-2", "qa-spell-4"]],
    ["personal owner", { role: "premium" as const, userId: IDS.users.owner }, ["qa-spell-1", "qa-spell-2", "qa-spell-3"]],
    ["admin", { role: "admin" as const, userId: IDS.users.admin }, ["qa-spell-1", "qa-spell-2", "qa-spell-3", "qa-spell-4"]],
  ] as const;
  for (const [name, user, expected] of cases) {
    const result = await service.listEntries(user, { edition: "5.5e", language: "en" });
    assert.deepEqual(result.entries.map(({ canonicalKey }) => canonicalKey).sort(), [...expected].sort(), name);
  }

  const noContent = await service.listEntries({ role: "user", userId: IDS.users.empty }, { edition: "5e", language: "ru" });
  assert.deepEqual(noContent, { entries: [], count: 0 });
  const scoped = await service.listEntries({ role: "admin", userId: IDS.users.admin }, { edition: "5e", language: "en" });
  assert.deepEqual(scoped.entries.map(({ canonicalKey }) => canonicalKey), ["qa-spell-5"]);
  await assert.rejects(service.getSource({ role: "user", userId: IDS.users.regular }, IDS.sources.premium), CompendiumNotFoundError);
  assert.equal((await service.getSource({ role: "premium", userId: IDS.users.premium }, IDS.sources.premium)).id, IDS.sources.premium);
  assert.equal((await service.getSource({ role: "premium", userId: IDS.users.owner }, IDS.sources.personal)).id, IDS.sources.personal);
});

test("QA integration: failed imports retry and replay idempotently using persisted checkpoints", async (t) => {
  const db = await isolatedDatabase("imports");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);
  const service = new CompendiumImportRunService(async (callback) => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
  const input = {
    sourceId: IDS.sources.open,
    fileId: "30000000-0000-4000-8000-000000000001",
    generationId: null,
    importer: "qa-importer",
    importerVersion: "1",
    parserVersion: "1",
    promptVersion: "none",
    modelVersion: "none",
    inputSha256: "d".repeat(64),
    actor: "qa",
  } as const;
  const run = await service.createRun(input);
  assert.equal((await service.createRun(input)).id, run.id, "create is idempotent");
  const firstClaim = await service.claimRun(run.id, "qa");
  assert.ok(firstClaim.leaseToken);
  const occurrence = { occurrenceIndex: 0, locator: "qa://one", fingerprintSha256: "e".repeat(64) };
  await service.recordOccurrences(run.id, firstClaim.leaseToken, [occurrence], "qa");
  await service.failRun(run.id, firstClaim.leaseToken, "qa", "injected parser failure");

  const retry = await service.claimRun(run.id, "qa-retry");
  assert.ok(retry.leaseToken);
  await service.recordOccurrences(run.id, retry.leaseToken, [occurrence], "qa-retry");
  const candidates = [{ occurrenceIndex: 0, candidateKey: "qa-imported-spell", entryType: "spell" as const, content: { title: "Imported" } }];
  const firstDiff = await service.computeCandidateDiff(run.id, retry.leaseToken, candidates, "qa-retry");
  const replay = await service.computeCandidateDiff(run.id, retry.leaseToken, candidates, "qa-retry");
  assert.deepEqual(replay, firstDiff);
  await service.completeRun(run.id, retry.leaseToken, "qa-retry");
  const completed = await service.claimRun(run.id, "qa-after-complete");
  assert.equal(completed.completed, true);
  assert.equal(completed.leaseToken, null);
  const audit = await db.pool.query<{ event_type: string }>("SELECT event_type FROM compendium_import_audit WHERE import_run_id=$1 ORDER BY id", [run.id]);
  assert.deepEqual(audit.rows.map(({ event_type }) => event_type), ["created", "claimed", "occurrences_recorded", "failed", "claimed", "occurrences_recorded", "candidate_diff_computed", "completed"]);
});
