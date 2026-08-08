import assert from "node:assert/strict";
import test from "node:test";

import { CompendiumImportRunService, ImportRunConflictError } from "../../src/server/compendium/import-runs.ts";
import { CompendiumNotFoundError, CompendiumReadService } from "../../src/server/compendium/read-service.ts";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";
import { applyMigrationPrefix, IDS, isolatedDatabase, runProductionMigrations, seedAccessFixture } from "./postgres.mts";

test("QA integration: fresh and prefix-upgrade migrations are database-isolated and preserve data", async (t) => {
  const fresh = await isolatedDatabase("fresh");
  t.after(() => fresh.cleanup());
  await runProductionMigrations(fresh.url);
  const freshApplied = await fresh.pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
  assert.deepEqual(freshApplied.rows.map(({ version }) => version), [...MIGRATION_FILENAMES].sort());
  assert.equal((await fresh.pool.query("SELECT '[1,2,3]'::vector(3)")).rowCount, 1);

  const upgrade = await isolatedDatabase("upgrade");
  t.after(() => upgrade.cleanup());
  assert.notEqual(upgrade.databaseName, fresh.databaseName);
  const client = await upgrade.pool.connect();
  try {
    await applyMigrationPrefix(client, "0010_nfs_content_index_sync.sql");
    await client.query("INSERT INTO users(id,email,password_hash,role,display_name) VALUES ($1,'legacy@qa.invalid','legacy','premium','Legacy User')", [IDS.users.regular]);
    await client.query(
      `INSERT INTO sources(id,title,category,edition,language,access_tier,shared,publication_title)
       VALUES ($1,'Legacy Source','core_rules','5e','en','open',false,'Legacy Publication')`,
      [IDS.sources.open],
    );
  } finally {
    client.release();
  }
  const prefixCount = MIGRATION_FILENAMES.indexOf("0010_nfs_content_index_sync.sql") + 1;
  assert.equal(Number((await upgrade.pool.query<{ count: string }>("SELECT count(*) FROM schema_migrations")).rows[0]?.count), prefixCount);

  await runProductionMigrations(upgrade.url);
  await runProductionMigrations(upgrade.url);
  const upgraded = await upgrade.pool.query<{ count: string }>("SELECT count(*) FROM schema_migrations");
  assert.equal(Number(upgraded.rows[0]?.count), MIGRATION_FILENAMES.length);
  assert.deepEqual((await upgrade.pool.query("SELECT email,role::text,display_name FROM users WHERE id=$1", [IDS.users.regular])).rows[0], {
    email: "legacy@qa.invalid", role: "premium", display_name: "Legacy User",
  });
  assert.equal((await upgrade.pool.query<{ title: string }>("SELECT title FROM sources WHERE id=$1", [IDS.sources.open])).rows[0]?.title, "Legacy Source");
  assert.equal((await upgrade.pool.query("SELECT editor_head_revision_id FROM compendium_versions LIMIT 0")).rowCount, 0);
  assert.equal((await upgrade.pool.query("SELECT category FROM compendium_glossary LIMIT 0")).rowCount, 0);
});

test("QA integration: live role matrix is authorization-, source-, and corpus-scoped", async (t) => {
  const db = await isolatedDatabase("rbac");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);
  const service = new CompendiumReadService(db.pool);

  const cases = [
    ["anonymous-equivalent open policy", { role: "user" as const }, ["qa-spell-1"]],
    ["authenticated user", { role: "user" as const, userId: IDS.users.regular }, ["qa-spell-1"]],
    ["premium personal owner", { role: "premium" as const, userId: IDS.users.premium }, ["qa-spell-1", "qa-spell-2", "qa-spell-4"]],
    ["personal owner", { role: "premium" as const, userId: IDS.users.owner }, ["qa-spell-1", "qa-spell-2", "qa-spell-3"]],
    ["admin", { role: "admin" as const, userId: IDS.users.admin }, ["qa-spell-1", "qa-spell-2", "qa-spell-3", "qa-spell-4"]],
  ] as const;
  for (const [name, user, expected] of cases) {
    const result = await service.listEntries(user, { edition: "5.5e", language: "en" });
    assert.deepEqual(result.entries.map(({ canonicalKey }) => canonicalKey).sort(), [...expected].sort(), name);
  }

  const matchingProtectedCorpus = { edition: "5.5e" as const, language: "en" as const, category: "homebrew" as const };
  const noAccess = await service.listEntries({ role: "user", userId: IDS.users.empty }, matchingProtectedCorpus);
  const adminMatching = await service.listEntries({ role: "admin", userId: IDS.users.admin }, matchingProtectedCorpus);
  assert.deepEqual(noAccess, { entries: [], count: 0 }, "the user is empty because both matching English sources are protected");
  assert.equal(adminMatching.count, 2, "the same English corpus filter contains content for an authorized role");

  const legacyEdition = await service.listEntries({ role: "admin", userId: IDS.users.admin }, { edition: "5e", language: "en" });
  assert.deepEqual(legacyEdition.entries.map(({ canonicalKey }) => canonicalKey), ["qa-spell-5"]);
  await assert.rejects(service.getSource({ role: "user", userId: IDS.users.regular }, IDS.sources.premium), CompendiumNotFoundError);
  assert.equal((await service.getSource({ role: "premium", userId: IDS.users.premium }, IDS.sources.premium)).id, IDS.sources.premium);
  assert.equal((await service.getSource({ role: "premium", userId: IDS.users.owner }, IDS.sources.personal)).id, IDS.sources.personal);

  const boundaries = await db.pool.query<{ invalid: string }>(
    `SELECT count(*)::text AS invalid FROM compendium_versions v
     JOIN compendium_revisions active ON active.id=v.active_revision_id AND active.version_id=v.id
     JOIN compendium_revisions editor ON editor.id=v.editor_head_revision_id AND editor.version_id=v.id
     WHERE active.entry_type<>v.entry_type OR editor.entry_type<>v.entry_type`,
  );
  assert.equal(Number(boundaries.rows[0]?.invalid), 0);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM nfs_index_entries WHERE edition IS NULL OR language IS NULL")).rows[0]?.count), 0);
});

test("QA integration: transactional import crash rolls back, stale lease retries, and replay conflicts fail closed", async (t) => {
  const db = await isolatedDatabase("imports");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  await seedAccessFixture(db.pool);
  let injectAfterCallback = false;
  const service = new CompendiumImportRunService(async (callback) => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      if (injectAfterCallback) {
        injectAfterCallback = false;
        throw new Error("injected process failure after candidate persistence before commit");
      }
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
  assert.equal((await service.createRun(input)).id, run.id);
  const firstClaim = await service.claimRun(run.id, "qa", 1_000);
  assert.ok(firstClaim.leaseToken);
  const occurrence = { occurrenceIndex: 0, locator: "qa://one", fingerprintSha256: "e".repeat(64) };
  await service.recordOccurrences(run.id, firstClaim.leaseToken, [occurrence], "qa");
  const candidates = [{ occurrenceIndex: 0, candidateKey: "qa-imported-spell", entryType: "spell" as const, content: { title: "Imported" } }];

  injectAfterCallback = true;
  await assert.rejects(service.computeCandidateDiff(run.id, firstClaim.leaseToken, candidates, "qa"), /injected process failure/);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_candidates WHERE import_run_id=$1", [run.id])).rows[0]?.count), 0);
  assert.deepEqual((await db.pool.query("SELECT status::text,checkpoint FROM compendium_import_runs WHERE id=$1", [run.id])).rows[0], { status: "running", checkpoint: "occurrences" });

  await db.pool.query("UPDATE compendium_import_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [run.id]);
  const retry = await service.claimRun(run.id, "qa-retry");
  assert.ok(retry.leaseToken);
  assert.notEqual(retry.leaseToken, firstClaim.leaseToken);
  const firstDiff = await service.computeCandidateDiff(run.id, retry.leaseToken, candidates, "qa-retry");
  assert.deepEqual(await service.computeCandidateDiff(run.id, retry.leaseToken, candidates, "qa-retry"), firstDiff);
  await assert.rejects(
    service.computeCandidateDiff(run.id, retry.leaseToken, [{ ...candidates[0], content: { title: "Conflicting replay" } }], "qa-retry"),
    ImportRunConflictError,
  );
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_candidates WHERE import_run_id=$1", [run.id])).rows[0]?.count), 1);
  await service.completeRun(run.id, retry.leaseToken, "qa-retry");
  assert.deepEqual(await service.claimRun(run.id, "qa-after-complete"), { run: { ...run, status: "succeeded", checkpoint: "completed" }, leaseToken: null, completed: true });
});
