import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadPreparedSeed } from "../../src/server/corpus-seed/executor.ts";
import { prepareSeed, redact, validatePlan, writeManifestAtomic } from "../../src/server/corpus-seed/model.ts";
import { installSeedSource } from "../../src/server/corpus-seed/source-installer.ts";
import { reviewActionBatches, seedImportBatch } from "../../src/server/corpus-seed/batch.ts";
import { seedCommandIncomplete } from "../../src/server/corpus-seed/status.ts";
import { hierarchyDetailsFixture } from "../fixtures/character-options.mts";

const fixture = resolve("tests/fixtures/corpus-seed");

test("synthetic approved input validates with provenance and stable digests", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  assert.equal(prepared.slots[0].discovered, 1);
  assert.match(prepared.planDigest, /^[0-9a-f]{64}$/);
  assert.match(prepared.inputDigest, /^[0-9a-f]{64}$/);
  assert.equal(prepared.slots[0].manifestDigest, "f6b2708b17effd1b29117bd646d0320736bef96421ecae8a7e21eab1ecf78f22");
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
  const harness = fakeDependencies();
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
  const harness = fakeDependencies();
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
  const fileId = "10000000-0000-4000-8000-000000000009";
  await Promise.all(Array.from({ length: 4 }, () => installSeedSource(prepared.slots[0], fileId, dataRoot)));
  const source = JSON.parse(await readFile(join(dataRoot, "sources/synthetic-glossary-2024/source.json"), "utf8"));
  assert.equal(source.files[0].contentHash, `sha256:${prepared.slots[0].manifestDigest}`);
  assert.equal(source.files[0].mediaType, "application/vnd.dnd-firegory.snapshot+json");
  const installed = join(dataRoot, `sources/synthetic-glossary-2024/files/${fileId}.snapshot`);
  await writeFile(installed, "tampered");
  await assert.rejects(installSeedSource(prepared.slots[0], fileId, dataRoot), /different immutable content/);
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

test("class snapshots produce separate feature candidates before dependent classes", () => {
  const detail = hierarchyDetailsFixture()[0];
  const manifest = { schemaVersion: 2, parserVersion: "next-dnd-2024-v3", status: "complete", collectedAt: detail.fetchedAt,
    robots: { userAgent: "fixture", snapshot: {} as never, rules: [], evaluations: [] },
    categories: [{ requestedCategory: "class", discoveredCategory: "class", entryCount: 1, index: {} as never, details: [detail] }], parserFailures: [], diagnostics: [] };
  const common = { input: {} as never, manifest, manifestBytes: Buffer.alloc(0), manifestDigest: "a".repeat(64), manifestByteLength: 0,
    inputManifestDigest: "b".repeat(64), evidenceFiles: [], inputDigest: "c".repeat(64), discovered: 1 };
  const features = seedImportBatch({ ...common, planSlot: { id: "feature", contentType: "feature", snapshotCategory: "class", inputSlotId: "class", dependsOn: [], required: true } } as never);
  const classes = seedImportBatch({ ...common, planSlot: { id: "class", contentType: "class", snapshotCategory: "class", inputSlotId: "class", dependsOn: ["feature"], required: true } } as never);
  assert.equal(features.candidates.length, 2);
  assert.ok(features.candidates.every(({ entryType, content }) => entryType === "feature" && content.kind === "snapshotFeatureCandidate"));
  assert.deepEqual(features.occurrences.map(({ occurrenceIndex }) => occurrenceIndex), [0, 1]);
  assert.equal(classes.candidates.length, 1);
  assert.equal(classes.candidates[0].entryType, "class");
});

test("status fails closed for absent, pending, partial, stale publication, and stale index counts", () => {
  const result = (operation: "absent" | "pending" | "noop", counts: Partial<ReturnType<typeof baseCounts>> = {}) => ({
    slotId: "class", contentType: "class", sourceId: null, importRunId: null, operation,
    counts: { ...baseCounts(), ...counts }, failures: [], provenance: { canonicalSourceId: "source", originUrl: "https://next.dnd.su/class/", originId: "id", attribution: "test", license: "test", evidenceReference: "urn:test" },
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
});

test("approval policy and redaction fail closed on adversarial values", async () => {
  const root = await mkdtemp(join(tmpdir(), "corpus-seed-approval-")); await cp(fixture, root, { recursive: true });
  const inputs = JSON.parse(await readFile(join(root, "inputs.json"), "utf8"));
  inputs.slots[0].source.licenseApproval.approvedAt = "2999-01-01T00:00:00.000Z";
  await writeFile(join(root, "inputs.json"), JSON.stringify(inputs));
  await assert.rejects(prepareSeed(join(root, "plan.json"), join(root, "inputs.json")), /future/);
  const redacted = redact({ Api_Key: "secret", clientSecretValue: "secret", message: "Basic dXNlcjpwYXNz eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature ghp_abcdefghijklmnop https://user:pass@example.test/path?access_token=secret&safe=yes" }) as Record<string, unknown>;
  assert.equal(redacted.Api_Key, "[REDACTED]"); assert.equal(redacted.clientSecretValue, "[REDACTED]");
  assert.doesNotMatch(String(redacted.message), /dXNlc|eyJ|ghp_|user:pass|access_token=secret/);
});

function baseCounts() { return { discovered: 1, imported: 1, reviewed: 1, published: 1, indexed: 1, failures: 0 }; }

function fakeDependencies() {
  const state = { completed: false, failed: false, diffCalls: 0, publicationCalls: 0 };
  const sourceRow = {
    id: "10000000-0000-4000-8000-000000000001", title: "Synthetic 2024 Glossary", category: "core_rules", edition: "5.5e", language: "en",
    access_tier: "open", publication_code: "SYN-2024", publisher: "Test Fixture Authors", release_year: 2024,
    publication_revision: "synthetic-v1", external_origin_url: "https://next.dnd.su/glossary/", external_origin_id: "synthetic-fixture",
    attribution: "Synthetic fixture authored for this repository.", canonical_book_id: "synthetic-glossary", license: "CC0-1.0 synthetic fixture",
    metadata: { corpusSeed: { inputSlotId: "glossary", licenseApproval: { basis: "cc0-1.0", approvedBy: "synthetic-fixture-reviewer", approvedAt: "2026-08-08T00:00:00.000Z", evidenceUri: "urn:dnd-firegory:synthetic-fixture", evidenceSha256: "0899a8636745a274aa0da39782d27f5435dfcdfb425b053c6bfbb539d6e9a024" } } },
  };
  const run = { id: "10000000-0000-4000-8000-000000000003", sourceId: sourceRow.id, fileId: "10000000-0000-4000-8000-000000000002", generationId: null, status: "pending" as "pending" | "failed" | "succeeded", checkpoint: "created" as "created" | "diffed" | "completed" };
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
  const dependencies: { transaction: never; runs: never; db: typeof db; sourceInstaller: () => Promise<void>; afterImport?: () => Promise<void> } = {
    transaction: transaction as never,
    runs: runs as never,
    db,
    sourceInstaller: async () => {},
  };
  return { state, dependencies };
}
