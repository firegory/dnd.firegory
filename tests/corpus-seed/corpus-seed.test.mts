import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadPreparedSeed } from "../../src/server/corpus-seed/executor.ts";
import { captureSeedDescriptors, prepareCapturedSeed, prepareSeed, redact, sha256, validatePlan, writeManifestAtomic } from "../../src/server/corpus-seed/model.ts";
import { installSeedSource, verifySeedSource } from "../../src/server/corpus-seed/source-installer.ts";
import { reviewActionBatches, seedImportBatch } from "../../src/server/corpus-seed/batch.ts";
import { seedCommandIncomplete } from "../../src/server/corpus-seed/status.ts";
import { hierarchyDetailsFixture } from "../fixtures/character-options.mts";
import { COMPLETE_CLASS } from "../fixtures/character-options.mts";
import { nextDndCardFingerprint, parseNextDndDetail, parseNextDndIndex } from "../../src/server/compendium/next-dnd/parser.ts";
import { projectSnapshotFeatureCandidate, projectSnapshotHierarchyCandidate } from "../../src/server/compendium/candidate-publication.ts";
import { validateCanonicalRevisionDependencies } from "../../src/server/content-storage/validation.ts";
import { projectCanonicalRevisions } from "../../src/server/content-index/projection.ts";

const fixture = resolve("tests/fixtures/corpus-seed");

test("synthetic approved input validates with provenance and stable digests", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  assert.equal(prepared.slots[0].discovered, 1);
  assert.match(prepared.planDigest, /^[0-9a-f]{64}$/);
  assert.match(prepared.inputDigest, /^[0-9a-f]{64}$/);
  assert.equal(prepared.slots[0].manifestDigest, "57e9670b540a3e8bb0586e26a86c9aff9d878c017fbc90557b66a26cd4f2dd27");
});

test("input and source digest changes are observable", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-digest-"));
  await cp(fixture, root, { recursive: true });
  const original = await prepareSeed(join(root, "plan.json"), join(root, "inputs.json"));
  const inputs = JSON.parse(await readFile(join(root, "inputs.json"), "utf8"));
  inputs.slots[0].source.attribution = "Changed synthetic attribution.";
  await writeFile(join(root, "inputs.json"), JSON.stringify(inputs));
  const changed = await prepareSeed(join(root, "plan.json"), join(root, "inputs.json"));
  assert.notEqual(changed.inputDigest, original.inputDigest);
  assert.notEqual(changed.slots[0].inputDigest, original.slots[0].inputDigest);
  assert.notEqual(changed.slots[0].identities.versionedSourceId, original.slots[0].identities.versionedSourceId);
  assert.notEqual(changed.slots[0].identities.fileId, original.slots[0].identities.fileId);
  assert.notEqual(changed.slots[0].identities.runId, original.slots[0].identities.runId);
  assert.equal(changed.slots[0].manifestDigest, original.slots[0].manifestDigest);
});

test("malformed plan, unapproved type, source, and missing evidence fail closed", async () => {
  const plan = JSON.parse(await readFile(join(fixture, "plan.json"), "utf8"));
  assert.throws(() => validatePlan({ ...plan, extra: true }), /missing or unknown/);
  assert.throws(() => validatePlan({ ...plan, slots: [{ ...plan.slots[0], contentType: "adventure" }] }), /unsupported content type/);

  const root = await mkdtemp(join(tmpdir(), "corpus-seed-invalid-"));
  await cp(fixture, root, { recursive: true });
  const inputs = JSON.parse(await readFile(join(root, "inputs.json"), "utf8"));
  inputs.slots[0].source.originUrl = "http://example.test/private?token=secret";
  await writeFile(join(root, "inputs.json"), JSON.stringify(inputs));
  await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /credential-free HTTPS/);
  delete inputs.slots[0].source.licenseApproval;
  await writeFile(join(root, "inputs.json"), JSON.stringify(inputs));
  await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /missing or unknown/);

  const tamperedRoot = await mkdtemp(join(tmpdir(), "corpus-seed-tampered-"));
  await cp(fixture, tamperedRoot, { recursive: true });
  const manifest = JSON.parse(await readFile(join(tamperedRoot, "manifest.json"), "utf8"));
  manifest.categories[0].details[0].normalized.contentText = "Manifest-only injected text.";
  await writeFile(join(tamperedRoot, "manifest.json"), JSON.stringify(manifest));
  await assert.rejects(prepareSeed(join(tamperedRoot, "plan.json"), join(tamperedRoot, "inputs.json")), /normalized content does not match/);
});

test("fresh seed creates candidates, identical success is durable no-op, and never publishes", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  const harness = fakeDependencies(prepared.slots[0]);
  const first = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(first[0].operation, "loaded");
  assert.deepEqual(first[0].counts, { discovered: 1, imported: 1, reviewed: 0, published: 0, indexed: 0, failures: 0 });
  assert.equal(harness.state.publicationCalls, 0);
  const second = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(second[0].operation, "noop");
  assert.equal(harness.state.diffCalls, 1);
  assert.equal(harness.state.completed, true);
});

test("partial failure remains retryable and replays immutable import work", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  const harness = fakeDependencies(prepared.slots[0]);
  let inject = true;
  harness.dependencies.afterImport = async () => { if (inject) { inject = false; throw new Error("injected partial failure token=private"); } };
  const failed = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(failed[0].operation, "failed");
  assert.match(failed[0].failures[0], /token=\[REDACTED\]/);
  assert.equal(harness.state.failed, true);
  const retried = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(retried[0].operation, "resumed");
  assert.equal(harness.state.completed, true);
  assert.equal(harness.state.diffCalls, 2);
});

test("worker source installation is immutable, retryable, and publication-ready", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  const dataRoot = await mkdtemp(join(tmpdir(), "corpus-seed-source-"));
  await cp("content-repository", dataRoot, { recursive: true });
  const fileId = prepared.slots[0].identities.fileId;
  await Promise.all(Array.from({ length: 4 }, () => installSeedSource(prepared.slots[0], fileId, dataRoot)));
  const source = JSON.parse(await readFile(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`), "utf8"));
  assert.equal(source.files[0].contentHash, `sha256:${prepared.slots[0].manifestDigest}`);
  assert.equal(source.files[0].mediaType, "application/vnd.dnd-firegory.snapshot+json");
  const installed = join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/files/${fileId}.snapshot`);
  await writeFile(installed, "tampered");
  await assert.rejects(installSeedSource(prepared.slots[0], fileId, dataRoot), /different immutable content/);
  assert.equal((await readdir(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/files`))).some((name) => name.endsWith(".tmp")), false);
});

test("ambiguous commit after canonical install retries with the same deterministic identities", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  const dataRoot = await mkdtemp(join(tmpdir(), "corpus-seed-commit-")); await cp("content-repository", dataRoot, { recursive: true });
  const harness = fakeDependencies(prepared.slots[0]);
  const baseTransaction = harness.dependencies.transaction;
  let failCommit = true;
  harness.dependencies.transaction = (async (callback: never) => {
    const result = await (baseTransaction as never as (callback: never) => Promise<unknown>)(callback);
    if (failCommit) { failCommit = false; throw new Error("connection lost after COMMIT"); }
    return result;
  }) as never;
  harness.dependencies.sourceInstaller = installSeedSource;
  harness.dependencies.dataRoot = dataRoot;
  const failed = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(failed[0].operation, "failed");
  const sourcePath = join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`);
  assert.equal(JSON.parse(await readFile(sourcePath, "utf8")).files[0].fileId, prepared.slots[0].identities.fileId);
  const retried = await loadPreparedSeed(prepared, harness.dependencies);
  assert.equal(retried[0].operation, "loaded");
  assert.equal(retried[0].sourceId, prepared.slots[0].identities.sourceId);
  assert.equal(retried[0].importRunId, prepared.slots[0].identities.runId);
});

test("interrupted immutable installation removes temporary files and retries cleanly", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  const dataRoot = await mkdtemp(join(tmpdir(), "corpus-seed-temp-cleanup-")); await cp("content-repository", dataRoot, { recursive: true });
  let interrupted = false;
  await assert.rejects(installSeedSource(prepared.slots[0], prepared.slots[0].identities.fileId, dataRoot, {
    afterTemporaryWritten: () => { if (!interrupted) { interrupted = true; throw new Error("simulated process death before link"); } },
  }), /simulated process death/);
  const blobNames = await readdir(join(dataRoot, "blobs")); assert.equal(blobNames.some((name) => name.endsWith(".tmp")), false);
  await installSeedSource(prepared.slots[0], prepared.slots[0].identities.fileId, dataRoot);
  await verifySeedSource(prepared.slots[0], prepared.slots[0].identities.fileId, dataRoot);
});

test("captured descriptor bytes cannot be replaced before preparation", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-capture-")); await cp(fixture, root, { recursive: true });
  const captured = await captureSeedDescriptors(join(root, "plan.json"), join(root, "inputs.json"));
  await writeFile(join(root, "plan.json"), JSON.stringify({ schemaVersion: 1, planId: "replaced" }));
  await writeFile(join(root, "inputs.json"), JSON.stringify({ schemaVersion: 1, planId: "replaced", slots: [] }));
  const prepared = await prepareCapturedSeed(captured);
  assert.equal(prepared.plan.planId, "synthetic-2024-test-v1");
  assert.equal(prepared.slots[0].input.source.canonicalSourceId, "synthetic-glossary-2024");
});

test("run manifests are atomic, mode-restricted, redacted, and preserve old target on serialization failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-manifest-"));
  const target = join(root, "run.json");
  await writeFile(target, "old\n", { mode: 0o600 });
  await writeManifestAtomic(target, { counts: { spell: { discovered: 2, imported: 1 } }, token: "synthetic-value", failure: "postgres://example.invalid/db" });
  const written = JSON.parse(await readFile(target, "utf8"));
  assert.deepEqual(written.counts.spell, { discovered: 2, imported: 1 });
  assert.equal(written.token, "[REDACTED]");
  assert.equal(written.failure, "[REDACTED_DATABASE_URL]");
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(writeManifestAtomic(target, cyclic));
  assert.equal(JSON.parse(await readFile(target, "utf8")).token, "[REDACTED]");
});

test("generic redaction removes nested credentials without dropping provenance", () => {
  assert.deepEqual(redact({ provenance: { originUrl: "https://example.test/source", authorization: "Bearer private" } }), {
    provenance: { originUrl: "https://example.test/source", authorization: "[REDACTED]" },
  });
});

test("review actions honor the API maximum for more than 200 candidates", () => {
  const candidates = Array.from({ length: 451 }, (_, index) => ({ id: `candidate-${index}`, activeRevisionToken: index % 2 ? null : `rev-${"a".repeat(64)}` }));
  const batches = reviewActionBatches(candidates);
  assert.deepEqual(batches.map(({ candidateIds }) => candidateIds.length), [200, 200, 51]);
  assert.deepEqual(batches.flatMap(({ candidateIds }) => candidateIds), candidates.map(({ id }) => id));
  assert.ok(batches.every(({ candidateIds, activeRevisionTokens }) => Object.keys(activeRevisionTokens).length === candidateIds.length));
});

test("shared feature and class runs submit the same complete hierarchy candidate set", () => {
  const detail = hierarchyDetailsFixture()[0];
  const manifest = { schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: "complete", collectedAt: detail.fetchedAt,
    robots: { userAgent: "fixture", snapshot: {} as never, rules: [], evaluations: [] },
    categories: [{ requestedCategory: "class", discoveredCategory: "class", entryCount: 1, index: {} as never, details: [detail] }], parserFailures: [], diagnostics: [] };
  const common = { input: {} as never, manifest, manifestBytes: Buffer.alloc(0), manifestDigest: "a".repeat(64), manifestByteLength: 0,
    inputManifestDigest: "b".repeat(64), evidenceFiles: [], inputDigest: "c".repeat(64), discovered: 1 };
  const features = seedImportBatch({ ...common, planSlot: { id: "feature", contentType: "feature", snapshotCategory: "class", inputSlotId: "class", dependsOn: [], required: true } } as never);
  const classes = seedImportBatch({ ...common, planSlot: { id: "class", contentType: "class", snapshotCategory: "class", inputSlotId: "class", dependsOn: ["feature"], required: true } } as never);
  assert.deepEqual(features, classes);
  assert.deepEqual(features.candidates.map(({ entryType }) => entryType), ["feature", "feature", "class"]);
  assert.ok(features.candidates.slice(0, 2).every(({ content }) => content.kind === "snapshotFeatureCandidate"));
  assert.deepEqual(features.occurrences.map(({ occurrenceIndex }) => occurrenceIndex), [0, 1, 2]);
});

test("prepared and installed class evidence passes actual feature and class canonical projectors", async () => {
  const root = await syntheticClassSeedFixture();
  const prepared = await prepareSeed(join(root, "plan.json"), join(root, "inputs.json"));
  const dataRoot = await mkdtemp(join(tmpdir(), "corpus-seed-class-nfs-")); await cp("content-repository", dataRoot, { recursive: true });
  assert.equal(prepared.slots[0].planSlot.contentType, "feature"); assert.equal(prepared.slots[1].planSlot.contentType, "class");
  assert.equal(prepared.slots[0].identities.versionedSourceId, prepared.slots[1].identities.versionedSourceId);
  await installSeedSource(prepared.slots[0], prepared.slots[0].identities.fileId, dataRoot);
  const source = JSON.parse(await readFile(join(dataRoot, `sources/${prepared.slots[0].identities.versionedSourceId}/source.json`), "utf8"));
  const featureBatch = seedImportBatch(prepared.slots[0]); const classBatch = seedImportBatch(prepared.slots[1]);
  const evidence = (occurrence: typeof featureBatch.occurrences[number]) => ({ sourceUrl: occurrence.locator, fingerprintSha256: occurrence.fingerprintSha256,
    rawBlobPath: occurrence.rawBlobPath!, fetchedAt: occurrence.sourceFetchedAt!, fileChecksumSha256: prepared.slots[0].manifestDigest,
    indexUrl: occurrence.indexLocator!, indexFingerprintSha256: occurrence.indexFingerprintSha256!, rawIndexBlobPath: occurrence.rawIndexBlobPath!,
    indexFetchedAt: occurrence.indexSourceFetchedAt!, indexCardFingerprintSha256: occurrence.indexCardFingerprintSha256!, metadataEvidenceText: occurrence.metadataEvidenceText! });
  const features = featureBatch.candidates.flatMap((candidate, index) => candidate.entryType === "feature" ? [projectSnapshotFeatureCandidate(candidate.content, {
    candidateKey: candidate.candidateKey!, createdAt: prepared.slots[0].manifest.collectedAt, source,
    fileId: prepared.slots[0].identities.fileId, evidence: evidence(featureBatch.occurrences[index]),
  })] : []);
  const classIndex = classBatch.candidates.findIndex(({ entryType }) => entryType === "class"); const classCandidate = classBatch.candidates[classIndex];
  const classRevision = projectSnapshotHierarchyCandidate(classCandidate.content, { candidateKey: classCandidate.candidateKey!, entryType: "class",
    createdAt: prepared.slots[1].manifest.collectedAt, source, fileId: prepared.slots[1].identities.fileId, evidence: evidence(classBatch.occurrences[classIndex]) });
  for (const revision of [...features, classRevision]) await validateCanonicalRevisionDependencies(dataRoot, revision);
  const declaredFile = source.files[0], installedFile = join(dataRoot, declaredFile.path);
  const projections = projectCanonicalRevisions("seed-class-test", [...features, classRevision], [{ sourceId: source.sourceId, fileId: declaredFile.fileId,
    path: declaredFile.path, mediaType: declaredFile.mediaType, contentHash: declaredFile.contentHash, byteSize: (await stat(installedFile)).size }]);
  assert.deepEqual(features.map(({ entryId }) => entryId), COMPLETE_CLASS.features.map(({ canonicalId }) => canonicalId));
  assert.equal(classRevision.entryId, "class-17");
  assert.deepEqual(projections.find(({ entryId }) => entryId === "class-17")!.relations.map(({ targetEntryId }) => targetEntryId), COMPLETE_CLASS.features.map(({ canonicalId }) => canonicalId));
});

test("status fails closed for absent, pending, partial, stale publication, and stale index counts", () => {
  const result = (operation: "absent" | "pending" | "noop", counts: Partial<ReturnType<typeof baseCounts>> = {}) => ({
    slotId: "class", contentType: "class", sourceId: null, importRunId: null, operation,
    counts: { ...baseCounts(), ...counts }, failures: [], provenance: { canonicalSourceId: "source", originUrl: "https://next.dnd.su/class/", originId: "id", attribution: "synthetic", license: "synthetic", evidenceReference: "urn:approval", evidenceSha256: "a".repeat(64) },
  });
  assert.equal(seedCommandIncomplete("status", [result("absent")]), true);
  assert.equal(seedCommandIncomplete("status", [result("pending")]), true);
  for (const field of ["imported", "reviewed", "published", "indexed"] as const) assert.equal(seedCommandIncomplete("status", [result("noop", { [field]: 0 })]), true);
  assert.equal(seedCommandIncomplete("status", [result("noop")]), false);
});

test("snapshot roots and blob evidence reject symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-links-"));
  await cp(fixture, join(root, "actual"), { recursive: true });
  await symlink(join(root, "actual"), join(root, "linked"));
  const linkedInputs = JSON.parse(await readFile(join(root, "actual/inputs.json"), "utf8"));
  linkedInputs.slots[0].snapshotRoot = "../linked";
  linkedInputs.slots[0].manifestPath = "../linked/manifest.json";
  await writeFile(join(root, "actual/inputs.json"), JSON.stringify(linkedInputs));
  await assert.rejects(prepareSeed(join(root, "actual/plan.json"), join(root, "actual/inputs.json")), /symbolic link|aliases|escapes/);

  const copied = join(root, "copied"); await cp(fixture, copied, { recursive: true });
  const manifest = JSON.parse(await readFile(join(copied, "manifest.json"), "utf8"));
  const blob = join(copied, manifest.categories[0].details[0].blobPath);
  const external = join(root, "external.html"); await writeFile(external, await readFile(blob)); await unlink(blob); await symlink(external, blob);
  await assert.rejects(prepareSeed(join(copied, "plan.json"), join(copied, "inputs.json")), /symbolic link/);

  const configLink = join(root, "linked-plan.json"); await symlink(join(fixture, "plan.json"), configLink);
  await assert.rejects(prepareSeed(configLink, join(fixture, "inputs.json")), /symbolic link/);
});

test("approval policy and redaction fail closed on adversarial values", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-approval-")); await cp(fixture, root, { recursive: true });
  const inputs = JSON.parse(await readFile(join(root, "inputs.json"), "utf8"));
  inputs.slots[0].source.licenseApproval.approvedAt = "2999-01-01T00:00:00.000Z";
  await writeFile(join(root, "inputs.json"), JSON.stringify(inputs));
  await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /future/);
  for (const value of ["TODO legal review", "test reviewer", "placeholder approval"]) {
    const changed = JSON.parse(await readFile(join(fixture, "inputs.json"), "utf8"));
    changed.slots[0].source.licenseApproval.approvedBy = value;
    await writeFile(join(root, "inputs.json"), JSON.stringify(changed));
    await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /placeholder|outside/);
  }
  const zero = JSON.parse(await readFile(join(fixture, "inputs.json"), "utf8")); zero.slots[0].source.licenseApproval.evidenceSha256 = "0".repeat(64);
  await writeFile(join(root, "inputs.json"), JSON.stringify(zero));
  await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /evidenceSha256/);
  for (const [field, value, expected] of [["basis", "operator-permission", /outside/], ["approvedBy", "unlisted-legal-reviewer", /outside/],
    ["evidenceUri", "https://legal.invalid/approval", /not permitted/]] as const) {
    const changed = JSON.parse(await readFile(join(fixture, "inputs.json"), "utf8")); changed.slots[0].source.licenseApproval[field] = value;
    await writeFile(join(root, "inputs.json"), JSON.stringify(changed)); await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), expected);
  }
  const redacted = redact({ Api_Key: "secret", clientSecretValue: "secret", message: "Basic dXNlcjpwYXNz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature ghp_abcdefghijklmnop https://user:pass@example.test/path?access_token=secret&safe=yes" }) as Record<string, unknown>;
  assert.equal(redacted.Api_Key, "[REDACTED]"); assert.equal(redacted.clientSecretValue, "[REDACTED]");
  assert.doesNotMatch(String(redacted.message), /dXNlc|eyJ|ghp_|user:pass|access_token=secret/);
});

function baseCounts() { return { discovered: 1, imported: 1, reviewed: 1, published: 1, indexed: 1, failures: 0 }; }

async function syntheticClassSeedFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-class-fixture-")); await mkdir(join(root, "blobs"));
  const metadata = { link: "/class/17-fighter", title: "Fighter", title_en: "Fighter", kind: COMPLETE_CLASS.kind, hit_die: `d${COMPLETE_CLASS.hitDie}`,
    primary_ability: COMPLETE_CLASS.primaryAbility, spellcasting_ability: COMPLETE_CLASS.spellcastingAbility, parent_class_ids: [],
    progression_columns: COMPLETE_CLASS.progressionColumns, progression_rows: COMPLETE_CLASS.progressionRows, features: COMPLETE_CLASS.features, cross_links: [] };
  const indexUrl = "https://next.dnd.su/class/", detailUrl = "https://next.dnd.su/class/17-fighter", collectedAt = "2026-08-08T00:00:00.000Z";
  const indexHtml = `<script>window.LIST = ${JSON.stringify({ category: "class", cards: [metadata], order: {} })};</script>`;
  const detailHtml = '<article class="card" data-id="class:17"><h1 class="card-title" data-copy="Fighter">Fighter</h1><p>Complete synthetic Fighter rules.</p></article>';
  const robots = "User-agent: *\nAllow: /\n";
  const resources = { robots: Buffer.from(robots), index: Buffer.from(indexHtml), detail: Buffer.from(detailHtml) };
  const hashes = Object.fromEntries(Object.entries(resources).map(([key, bytes]) => [key, sha256(bytes)])) as Record<keyof typeof resources, string>;
  for (const [key, bytes] of Object.entries(resources)) await writeFile(join(root, `blobs/${hashes[key as keyof typeof resources]}.html`), bytes);
  const normalized = parseNextDndDetail(detailHtml, "class", "17");
  const parsed = parseNextDndIndex(indexHtml, indexUrl, "class").entries[0];
  const resource = (kind: "robots" | "index" | "detail", sourceUrl: string, hash: string, byteLength: number, category: "class" | null, externalId: string | null) => ({
    kind, category, externalId, sourceUrl, finalUrl: sourceUrl, redirectChain: [], fetchedAt: collectedAt, sha256: hash, byteLength,
    parserVersion: "next-dnd-2024-v3", blobPath: `blobs/${hash}.html`,
  });
  const manifest = { schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: "complete", collectedAt,
    robots: { userAgent: "dnd.firegory.site-snapshot", snapshot: resource("robots", "https://next.dnd.su/robots.txt", hashes.robots, resources.robots.byteLength, null, null),
      rules: [{ directive: "allow", path: "/" }], evaluations: [indexUrl, detailUrl].map((sourceUrl) => ({ sourceUrl, allowed: true })) },
    categories: [{ requestedCategory: "class", discoveredCategory: "class", entryCount: 1,
      index: resource("index", indexUrl, hashes.index, resources.index.byteLength, "class", null),
      details: [{ ...resource("detail", detailUrl, hashes.detail, resources.detail.byteLength, "class", "17"), normalized, indexMetadata: parsed.metadata,
        indexSource: { url: indexUrl, fingerprintSha256: hashes.index, rawBlobPath: `blobs/${hashes.index}.html`, fetchedAt: collectedAt, cardFingerprintSha256: nextDndCardFingerprint(parsed.metadata) } }] }],
    parserFailures: [], diagnostics: [] };
  await writeFile(join(root, "manifest.json"), JSON.stringify(manifest));
  await writeFile(join(root, "plan.json"), JSON.stringify({ schemaVersion: 1, planId: "synthetic-class-2024-v1", edition: "5.5e", description: "Synthetic class and feature lifecycle.",
    slots: [{ id: "feature", contentType: "feature", snapshotCategory: "class", inputSlotId: "class", dependsOn: [], required: true },
      { id: "class", contentType: "class", snapshotCategory: "class", inputSlotId: "class", dependsOn: ["feature"], required: true }],
    sourceRequirements: { format: "next-dnd-snapshot-v2", operatorSupplied: true, licenseApprovalRequired: true, attributionRequired: true, provenanceRequired: true,
      allowedLicenseBases: ["cc0-1.0"], approvedBy: ["corpus-legal-reviewer"], evidenceSchemes: ["urn:"] }, exclusions: ["All non-synthetic content"] }));
  await writeFile(join(root, "inputs.json"), JSON.stringify({ schemaVersion: 1, planId: "synthetic-class-2024-v1", slots: [{ slotId: "class", snapshotRoot: ".", manifestPath: "manifest.json",
    source: { canonicalSourceId: "synthetic-class-2024", title: "Synthetic Fighter", language: "en", category: "core_rules", accessTier: "open",
      publicationCode: "SYN-CLASS", publisher: "Synthetic Corpus Authors", revision: "v1", canonicalBookId: "synthetic-class", originUrl: indexUrl,
      originId: "synthetic-class-fixture", attribution: "Synthetic corpus authored for automated verification.", license: "CC0-1.0 synthetic corpus",
      licenseApproval: { basis: "cc0-1.0", approvedBy: "corpus-legal-reviewer", approvedAt: collectedAt,
        evidenceUri: "urn:dnd-firegory:legal-approval:synthetic-class", evidenceSha256: "a".repeat(64) } } }] }));
  return root;
}

function fakeDependencies(slot: Awaited<ReturnType<typeof prepareSeed>>["slots"][number]) {
  const state = { completed: false, failed: false, diffCalls: 0, publicationCalls: 0 };
  const sourceRow = {
    id: slot.identities.sourceId, title: "Synthetic 2024 Glossary", category: "core_rules", edition: "5.5e", language: "en",
    access_tier: "open", publication_code: "SYN-2024", publisher: "Synthetic Corpus Authors", release_year: 2024,
    publication_revision: "synthetic-v1", external_origin_url: "https://next.dnd.su/glossary/", external_origin_id: "synthetic-fixture",
    attribution: "Synthetic fixture authored for this repository.", canonical_book_id: "synthetic-glossary", license: "CC0-1.0 synthetic fixture",
    metadata: { corpusSeed: { baseCanonicalSourceId: "synthetic-glossary-2024", inputSlotId: "glossary", versionDigest: slot.identities.versionDigest, licenseApproval: { basis: "cc0-1.0", approvedBy: "synthetic-fixture-reviewer", approvedAt: "2026-08-08T00:00:00.000Z", evidenceUri: "urn:dnd-firegory:synthetic-fixture", evidenceSha256: "0899a8636745a274aa0da39782d27f5435dfcdfb425b053c6bfbb539d6e9a024" } } },
  };
  const run = { id: slot.identities.runId, sourceId: sourceRow.id, fileId: slot.identities.fileId, generationId: null, status: "pending" as "pending" | "failed" | "succeeded", checkpoint: "created" as "created" | "diffed" | "completed" };
  const lease = "10000000-0000-4000-8000-000000000004";
  const transaction = async <T>(callback: (client: { query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> }) => Promise<T>) => callback({
    async query(sql: string) {
      if (sql.includes("FROM sources WHERE canonical_source_id")) return { rows: [sourceRow], rowCount: 1 };
      if (sql.includes("INSERT INTO files")) return { rows: [{ id: run.fileId }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  });
  const runs = {
    async createRun() { run.status = state.completed ? "succeeded" : state.failed ? "failed" : "pending"; run.checkpoint = state.completed ? "completed" : state.failed ? "diffed" : "created"; return { ...run }; },
    async claimRun() { return state.completed ? { run: { ...run }, leaseToken: null, completed: true } : { run: { ...run, status: "running" }, leaseToken: lease, completed: false }; },
    async recordOccurrences() {},
    async computeCandidateDiff() { state.diffCalls++; return [{ id: "candidate", candidateKey: "glossary-1", diffStatus: "new", contentSha256: "a".repeat(64) }]; },
    async addDiagnostic() {},
    async completeRun() { state.completed = true; state.failed = false; },
    async failRun() { state.failed = true; },
  };
  const db = { async query() { return { rows: [{ imported: 1, reviewed: 0, published: state.publicationCalls, indexed: 0 }] }; } };
  const dependencies: { transaction: never; runs: never; db: typeof db; sourceInstaller: typeof installSeedSource | (() => Promise<void>); dataRoot?: string; afterImport?: () => Promise<void> } = {
    transaction: transaction as never,
    runs: runs as never,
    db,
    sourceInstaller: async () => {},
  };
  return { state, dependencies };
}
