import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CompendiumImportRunService, ImportRunConflictError } from "../../src/server/compendium/import-runs.ts";
import { projectSnapshotFlatCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { CompendiumImportReviewService } from "../../src/server/compendium/import-review.ts";
import { recordImportReviewPublicationOutcome } from "../../src/server/compendium/import-review-outcomes.ts";
import { CompendiumNotFoundError, CompendiumReadService } from "../../src/server/compendium/read-service.ts";
import { seedImportBatch } from "../../src/server/corpus-seed/batch.ts";
import { inspectPreparedSeed, loadPreparedSeed, seedSlotCounts } from "../../src/server/corpus-seed/executor.ts";
import { prepareSeed } from "../../src/server/corpus-seed/model.ts";
import { synchronizeContentIndex } from "../../src/server/content-index/sync.ts";
import { projectCanonicalRevisions } from "../../src/server/content-index/projection.ts";
import { formatPublicationGeneration, type ContentSource } from "../../src/server/content-storage/repository.ts";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";
import { PostgresPublicationFenceManager } from "../../src/worker/publication/fence.ts";
import { publishCanonicalRevision } from "../../src/worker/publication/publisher.ts";
import { COMPLETE_CLASS, hierarchyDetailsFixture } from "../fixtures/character-options.mts";
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
    await seedPre0014Compendium(client);
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
  await assertLegacyCompendiumPreserved(upgrade.pool);
  await assertActiveRevisionTriggerRejectsMissingProjection(upgrade.pool);
  assert.equal((await upgrade.pool.query("SELECT category FROM compendium_glossary LIMIT 0")).rowCount, 0);

  const applied0014 = await isolatedDatabase("applied_0014");
  t.after(() => applied0014.cleanup());
  const appliedClient = await applied0014.pool.connect();
  let originalAppliedAt: string;
  try {
    await applyMigrationPrefix(appliedClient, "0013_compendium_import_review.sql");
    await appliedClient.query(
      `INSERT INTO sources(id,title,category,edition,language,access_tier,shared,publication_title)
       VALUES ($1,'Legacy Source','core_rules','5e','en','open',false,'Legacy Publication')`,
      [IDS.sources.open],
    );
    await seedPre0014Compendium(appliedClient);
    await applyMigrationPrefix(appliedClient, "0014_compendium_entry_editor.sql");
    originalAppliedAt = (await appliedClient.query<{ applied_at: string }>(
      "SELECT applied_at::text FROM schema_migrations WHERE version='0014_compendium_entry_editor.sql'",
    )).rows[0]!.applied_at;
    await installHistoricalBrokenActiveRevisionFunction(appliedClient);
  } finally {
    appliedClient.release();
  }
  await runProductionMigrations(applied0014.url);
  assert.equal(
    (await applied0014.pool.query<{ applied_at: string }>(
      "SELECT applied_at::text FROM schema_migrations WHERE version='0014_compendium_entry_editor.sql'",
    )).rows[0]?.applied_at,
    originalAppliedAt!,
    "version-only registry must skip the historical 0014 edit on already-applied installations",
  );
  await assertLegacyCompendiumPreserved(applied0014.pool);
  await assertActiveRevisionTriggerRejectsMissingProjection(applied0014.pool);
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

test("QA integration: shared feature and class snapshots never cross-synthesize missing candidates", async (t) => {
  const db = await isolatedDatabase("shared_hierarchy_seed");
  t.after(() => db.cleanup());
  await runProductionMigrations(db.url);
  const sourceId = "71000000-0000-4000-8000-000000000001", fileId = "71000000-0000-4000-8000-000000000002";
  await db.pool.query(`INSERT INTO sources
    (id,canonical_source_id,title,category,edition,language,access_tier,shared,publication_code,publication_title,publisher,
     release_year,publication_revision,external_origin_url,external_origin_id,attribution,source_priority,canonical_book_id,license)
    VALUES($1,'qa-shared-hierarchy','QA Shared Hierarchy','core_rules','5.5e','en','open',false,'QA-HIERARCHY','QA Shared Hierarchy',
      'QA Synthetic Authors',2024,'v1','https://next.dnd.su/class/','qa-shared-hierarchy','Synthetic QA fixture.',0,'qa-shared-hierarchy','CC0-1.0 synthetic fixture')`, [sourceId]);
  await db.pool.query(`INSERT INTO files(id,source_id,original_filename,mime_type,checksum_sha256,byte_size,storage_path)
    VALUES($1,$2,'class.snapshot','application/vnd.dnd-firegory.snapshot+json',$3,1,'canonical-seed:qa-shared-hierarchy')`, [fileId, sourceId, "a".repeat(64)]);
  const detail = hierarchyDetailsFixture()[0];
  const manifest = { schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: "complete", collectedAt: detail.fetchedAt,
    robots: { userAgent: "fixture", snapshot: {} as never, rules: [], evaluations: [] },
    categories: [{ requestedCategory: "class", discoveredCategory: "class", entryCount: 1, index: {} as never, details: [detail] }], parserFailures: [], diagnostics: [] };
  const slot = (id: "feature" | "class") => ({ manifest, planSlot: { id, contentType: id, snapshotCategory: "class", inputSlotId: "class",
    dependsOn: id === "class" ? ["feature"] : [], required: true } } as never);
  const featureBatch = seedImportBatch(slot("feature")), classBatch = seedImportBatch(slot("class"));
  assert.deepEqual(featureBatch, classBatch);

  const transaction = async <T>(callback: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.pool.connect();
    try { await client.query("BEGIN"); const result = await callback(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  };
  const runs = new CompendiumImportRunService(transaction as never);
  const runInput = (id: "feature" | "class") => ({ id: id === "feature" ? "71000000-0000-4000-8000-000000000003" : "71000000-0000-4000-8000-000000000004",
    sourceId, fileId, importer: "approved-2024-corpus-seed", importerVersion: "1", parserVersion: "next-dnd-2024-v3",
    promptVersion: "none", modelVersion: "none", inputSha256: id === "feature" ? "1".repeat(64) : "2".repeat(64), actor: "qa-corpus-seed" });
  const load = async (id: "feature" | "class", batch: typeof featureBatch) => {
    const run = await runs.createRun(runInput(id)); const claim = await runs.claimRun(run.id, "qa-corpus-seed"); assert.ok(claim.leaseToken);
    await runs.recordOccurrences(run.id, claim.leaseToken, batch.occurrences, "qa-corpus-seed");
    const candidates = await runs.computeCandidateDiff(run.id, claim.leaseToken, batch.candidates, "qa-corpus-seed");
    await runs.completeRun(run.id, claim.leaseToken, "qa-corpus-seed"); return { run, candidates };
  };
  const feature = await load("feature", featureBatch), classes = await load("class", classBatch);
  assert.deepEqual(feature.candidates.map(({ candidateKey, contentSha256 }) => [candidateKey, contentSha256]),
    classes.candidates.map(({ candidateKey, contentSha256 }) => [candidateKey, contentSha256]));
  assert.equal(feature.candidates.every(({ diffStatus }) => diffStatus === "new"), true);
  assert.equal(classes.candidates.every(({ diffStatus }) => diffStatus === "unchanged"), true);
  for (const id of ["feature", "class"] as const) {
    const repeated = await runs.createRun(runInput(id)); assert.equal(repeated.id, runInput(id).id);
    assert.deepEqual(await runs.claimRun(repeated.id, "qa-repeat"), { run: { ...repeated, status: "succeeded", checkpoint: "completed" }, leaseToken: null, completed: true });
  }
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_runs")).rows[0].count), 2);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_candidates WHERE diff_status='missing' AND entry_type IN ('feature','class')")).rows[0].count), 0);

  const submitted: Array<{ revision: import("../../src/server/content-storage/repository.ts").CanonicalRevision }> = [];
  const review = new CompendiumImportReviewService(transaction as never, {
    publish: async (input) => { submitted.push(input); return { commandPath: "/qa/spool", existing: false }; },
    unpublish: async () => { throw new Error("shared hierarchy seed must not unpublish"); },
  }, async (entryIds) => new Map(entryIds.map((entryId) => [entryId, null])));
  const admin = { userId: "71000000-0000-4000-8000-000000000005", role: "admin" } as const;
  const featureReview = await review.getRun(admin, feature.run.id), classReview = await review.getRun(admin, classes.run.id);
  assert.equal([...featureReview.candidates, ...classReview.candidates].some(({ publicationCapability }) => publicationCapability === "can_unpublish"), false);
  const featureCandidates = featureReview.candidates.filter(({ entryType }) => entryType === "feature");
  const classCandidates = classReview.candidates.filter(({ entryType }) => entryType === "class");
  await review.act(admin, feature.run.id, { action: "approve", candidateIds: featureCandidates.map(({ id }) => id),
    activeRevisionTokens: Object.fromEntries(featureCandidates.map(({ id }) => [id, null])) });
  await review.act(admin, classes.run.id, { action: "approve", candidateIds: classCandidates.map(({ id }) => id),
    activeRevisionTokens: Object.fromEntries(classCandidates.map(({ id }) => [id, null])) });
  const source = submitted[0].revision.source, file = source.files[0];
  const projections = projectCanonicalRevisions("qa-shared-hierarchy", submitted.map(({ revision }) => revision), [{ sourceId: source.sourceId,
    fileId: file.fileId, path: file.path, mediaType: file.mediaType, contentHash: file.contentHash, byteSize: 1 }]);
  assert.deepEqual(submitted.filter(({ revision }) => revision.entryId.startsWith("feature-")).map(({ revision }) => revision.entryId), COMPLETE_CLASS.features.map(({ canonicalId }) => canonicalId));
  assert.deepEqual(projections.find(({ entryId }) => entryId === "class-17")!.relations.map(({ targetEntryId }) => targetEntryId), COMPLETE_CLASS.features.map(({ canonicalId }) => canonicalId));
});

test("QA integration: fresh corpus seed persists candidates and identical input is a DB-backed no-op", async (t) => {
  const db = await isolatedDatabase("corpus_seed");
  t.after(() => db.cleanup());
  const dataRoot = await mkdtemp(join(tmpdir(), "qa-corpus-seed-nfs-"));
  t.after(() => rm(dataRoot, { recursive: true, force: true }));
  await cp("content-repository", dataRoot, { recursive: true });
  await runProductionMigrations(db.url);
  const transaction = async <T>(callback: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
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
  };
  const prepared = await prepareSeed("tests/fixtures/corpus-seed/plan.json", "tests/fixtures/corpus-seed/inputs.json");
  let rollBackAfterNfs = true;
  const nfsBeforeDbCrash = async <T>(callback: (client: import("pg").PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await callback(client);
      if (rollBackAfterNfs) {
        rollBackAfterNfs = false;
        throw new Error("injected crash after canonical NFS installation before database commit");
      }
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const crashed = await loadPreparedSeed(prepared, {
    transaction: nfsBeforeDbCrash as never,
    db: db.pool,
    runs: new CompendiumImportRunService(nfsBeforeDbCrash as never),
    dataRoot,
  });
  assert.equal(crashed[0].operation, "failed");
  assert.match(crashed[0].failures[0], /injected crash/);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM sources")).rows[0].count), 0);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM files")).rows[0].count), 0);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_runs")).rows[0].count), 0);
  assert.equal((await readFile(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`), "utf8")).includes(prepared.slots[0].identities.fileId), true);
  const dependencies = { transaction: transaction as never, db: db.pool, runs: new CompendiumImportRunService(transaction as never), dataRoot };
  const first = await loadPreparedSeed(prepared, dependencies);
  assert.equal(first[0].operation, "loaded", JSON.stringify(first[0]));
  assert.deepEqual(first[0].counts, { discovered: 1, imported: 1, reviewed: 0, published: 0, indexed: 0, failures: 0 });
  const second = await loadPreparedSeed(prepared, dependencies);
  assert.equal(second[0].operation, "noop");
  assert.equal(second[0].importRunId, first[0].importRunId);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_runs")).rows[0].count), 1);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_candidates")).rows[0].count), 1);
  const candidateId = (await db.pool.query<{ id: string }>("SELECT id FROM compendium_import_candidates WHERE import_run_id=$1", [first[0].importRunId])).rows[0].id;
  const reviewValues = [candidateId, first[0].importRunId, "review-qa-corpus-seed", "qa-corpus-reviewer"];
  await assert.rejects(db.pool.query(
    `INSERT INTO compendium_import_candidate_reviews
       (candidate_id,import_run_id,decision,publication_status,publication_attempt,idempotency_key,
        expected_active_revision_captured,reviewed_by,reviewed_at,canonical_revision_id)
     VALUES ($1,$2,'approved','completed',1,$3,true,$4,now(),NULL)`, reviewValues,
  ), /compendium_review_canonical_revision_shape/);
  await db.pool.query(
    `INSERT INTO compendium_import_candidate_reviews
       (candidate_id,import_run_id,decision,publication_status,publication_attempt,idempotency_key,
        expected_active_revision_captured,reviewed_by,reviewed_at)
     VALUES ($1,$2,'approved','queued',1,$3,true,$4,now())`, reviewValues,
  );
  const stale = await inspectPreparedSeed(prepared, db.pool, dataRoot);
  assert.deepEqual({ reviewed: stale[0].counts.reviewed, published: stale[0].counts.published, indexed: stale[0].counts.indexed }, { reviewed: 1, published: 0, indexed: 0 });
  const batch = seedImportBatch(prepared.slots[0]);
  const occurrence = batch.occurrences[0];
  const source = JSON.parse(await readFile(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`), "utf8")) as ContentSource;
  const revision = projectSnapshotFlatCandidate(batch.candidates[0].content, {
    candidateKey: batch.candidates[0].candidateKey!,
    entryType: "glossary",
    createdAt: prepared.slots[0].manifest.collectedAt,
    source,
    fileId: prepared.slots[0].identities.fileId,
    evidence: {
      sourceUrl: occurrence.locator,
      fingerprintSha256: occurrence.fingerprintSha256,
      rawBlobPath: occurrence.rawBlobPath!,
      fetchedAt: occurrence.sourceFetchedAt!,
      fileChecksumSha256: prepared.slots[0].manifestDigest,
      indexUrl: occurrence.indexLocator!,
      indexFingerprintSha256: occurrence.indexFingerprintSha256!,
      rawIndexBlobPath: occurrence.rawIndexBlobPath!,
      indexFetchedAt: occurrence.indexSourceFetchedAt!,
      indexCardFingerprintSha256: occurrence.indexCardFingerprintSha256!,
      metadataEvidenceText: occurrence.metadataEvidenceText!,
    },
  });
  await publishCanonicalRevision({
    dataRoot,
    command: { schemaVersion: 2, kind: "publishCanonicalRevision", idempotencyKey: reviewValues[2], generation: formatPublicationGeneration(1n), expectedActiveRevisionId: null, revision },
    leaseManager: { async acquire() { return { ownerId: "70000000-0000-4000-8000-000000000001", async renew() { return true; }, async release() { return true; } }; } },
    fenceManager: new PostgresPublicationFenceManager(() => db.pool.connect()),
  });
  await recordImportReviewPublicationOutcome(reviewValues[2], "completed", null, revision.revisionId, transaction as never);
  assert.equal((await db.pool.query<{ canonical_revision_id: string }>("SELECT canonical_revision_id FROM compendium_import_candidate_reviews WHERE candidate_id=$1", [candidateId])).rows[0].canonical_revision_id, revision.revisionId);
  const published = await inspectPreparedSeed(prepared, db.pool, dataRoot);
  assert.deepEqual({ reviewed: published[0].counts.reviewed, published: published[0].counts.published, indexed: published[0].counts.indexed }, { reviewed: 1, published: 1, indexed: 0 });
  const sync = await synchronizeContentIndex({ mode: "incremental", dataRoot }, {
    execute: db.pool.query.bind(db.pool) as never,
    transaction: transaction as never,
    ownerToken: "70000000-0000-4000-8000-000000000002",
  });
  assert.equal(sync.plan.additions.includes(revision.entryId), true);
  const exact = await inspectPreparedSeed(prepared, db.pool, dataRoot);
  assert.deepEqual(exact[0].counts, { discovered: 1, imported: 1, reviewed: 1, published: 1, indexed: 1, failures: 0 });
  const active = { repositoryId: sync.repositoryId, generation: sync.generation, entries: [{ entryId: revision.entryId, revisionId: revision.revisionId }] };
  const staleRevision = await seedSlotCounts(prepared.slots[0], db.pool, first[0].sourceId!, first[0].importRunId!, {
    ...active, entries: [{ entryId: revision.entryId, revisionId: `rev-${"d".repeat(64)}` }],
  });
  assert.deepEqual({ published: staleRevision.published, indexed: staleRevision.indexed }, { published: 0, indexed: 0 });
  await db.pool.query(`INSERT INTO nfs_index_sync_runs(id,repository_id,mode,manifest_hash,projection_hash,projector_version,repository_generation,status,
    planned_additions,planned_updates,planned_removals,finished_at) VALUES($1,$2,'incremental',$3,$3,1,$4,'succeeded',0,0,0,now()+interval '1 second')`,
    ["70000000-0000-4000-8000-000000000005", sync.repositoryId, `sha256:${"e".repeat(64)}`, "20260808000000000000000000000001"]);
  const oldGeneration = await seedSlotCounts(prepared.slots[0], db.pool, first[0].sourceId!, first[0].importRunId!, active);
  assert.equal(oldGeneration.indexed, 0);
  assert.equal(Number((await db.pool.query<{ count: string }>("SELECT count(*) FROM compendium_import_candidate_reviews")).rows[0].count), 1);
  assert.equal((await readFile(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`), "utf8")).includes("synthetic-glossary-2024"), true);
});

const LEGACY_ENTRY_ID = "50000000-0000-4000-8000-000000000099";
const LEGACY_VERSION_ID = "60000000-0000-4000-8000-000000000099";
const LEGACY_REVISION_ID = "61000000-0000-4000-8000-000000000099";
const LEGACY_FILE_ID = "30000000-0000-4000-8000-000000000099";

async function seedPre0014Compendium(client: import("pg").PoolClient): Promise<void> {
  // 0007's function cannot resolve its table-specific NEW fields. Disable only
  // those two fixture triggers while committing otherwise constraint-valid data.
  await client.query("ALTER TABLE compendium_versions DISABLE TRIGGER compendium_versions_active_revision_valid");
  await client.query("ALTER TABLE compendium_revisions DISABLE TRIGGER compendium_revisions_active_revision_valid");
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO files(id,source_id,original_filename,mime_type,checksum_sha256,byte_size,storage_path)
       VALUES ($1,$2,'legacy.pdf','application/pdf',$3,128,'/tmp/legacy.pdf')`,
      [LEGACY_FILE_ID, IDS.sources.open, "9".repeat(64)],
    );
    await client.query(
      "INSERT INTO compendium_entries(id,canonical_key,entry_type,edition) VALUES ($1,'legacy-spell','spell','5e')",
      [LEGACY_ENTRY_ID],
    );
    await client.query(
      `INSERT INTO compendium_versions(id,entry_id,entry_type,edition,language,source_id,file_id,lifecycle,active_revision_id)
       VALUES ($1,$2,'spell','5e','en',$3,$4,'draft',$5)`,
      [LEGACY_VERSION_ID, LEGACY_ENTRY_ID, IDS.sources.open, LEGACY_FILE_ID, LEGACY_REVISION_ID],
    );
    await client.query(
      `INSERT INTO compendium_revisions(id,version_id,entry_type,revision_number,lifecycle,title,summary,body)
       VALUES ($1,$2,'spell',1,'draft','Legacy Spell','Preserved summary','Preserved body')`,
      [LEGACY_REVISION_ID, LEGACY_VERSION_ID],
    );
    await client.query(
      `INSERT INTO compendium_spells(revision_id,level,school,casting_time,range_text,duration,components)
       VALUES ($1,3,'evocation','1 action','60 feet','Instantaneous','V, S')`,
      [LEGACY_REVISION_ID],
    );
    await client.query(
      `INSERT INTO compendium_names(version_id,entry_id,entry_type,edition,language,kind,name)
       VALUES ($1,$2,'spell','5e','en','slug','legacy-spell')`,
      [LEGACY_VERSION_ID, LEGACY_ENTRY_ID],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.query("ALTER TABLE compendium_versions ENABLE TRIGGER compendium_versions_active_revision_valid");
    await client.query("ALTER TABLE compendium_revisions ENABLE TRIGGER compendium_revisions_active_revision_valid");
  }
}

async function assertLegacyCompendiumPreserved(database: import("pg").Pool): Promise<void> {
  const preserved = await database.query(
    `SELECT e.canonical_key,v.active_revision_id,v.editor_head_revision_id,r.title,s.level
     FROM compendium_entries e
     JOIN compendium_versions v ON v.entry_id=e.id
     JOIN compendium_revisions r ON r.id=v.active_revision_id AND r.version_id=v.id
     JOIN compendium_spells s ON s.revision_id=r.id
     WHERE e.id=$1`,
    [LEGACY_ENTRY_ID],
  );
  assert.deepEqual(preserved.rows[0], {
    canonical_key: "legacy-spell",
    active_revision_id: LEGACY_REVISION_ID,
    editor_head_revision_id: LEGACY_REVISION_ID,
    title: "Legacy Spell",
    level: 3,
  });
}

async function assertActiveRevisionTriggerRejectsMissingProjection(database: import("pg").Pool): Promise<void> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO compendium_revisions(version_id,entry_type,revision_number,lifecycle,title,body,created_by,change_reason)
       VALUES ($1,'spell',2,'draft','Invalid active revision','No projection','qa','trigger verification')`,
      [LEGACY_VERSION_ID],
    );
    const nextRevision = (await client.query<{ id: string }>(
      "SELECT id FROM compendium_revisions WHERE version_id=$1 AND revision_number=2",
      [LEGACY_VERSION_ID],
    )).rows[0]!.id;
    await client.query("UPDATE compendium_versions SET active_revision_id=$2 WHERE id=$1", [LEGACY_VERSION_ID, nextRevision]);
    await assert.rejects(client.query("COMMIT"), /active revision requires its matching typed projection/);
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}

async function installHistoricalBrokenActiveRevisionFunction(client: import("pg").PoolClient): Promise<void> {
  await client.query(`
    CREATE OR REPLACE FUNCTION compendium_validate_active_revision() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE target_version uuid;
    BEGIN
      target_version := CASE WHEN TG_TABLE_NAME = 'compendium_versions' THEN NEW.id ELSE NEW.version_id END;
      RETURN NEW;
    END $$
  `);
}
