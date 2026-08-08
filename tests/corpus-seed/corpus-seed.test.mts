import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { loadPreparedSeed } from "../../src/server/corpus-seed/executor.ts";
import { prepareSeed, redact, validatePlan, writeManifestAtomic } from "../../src/server/corpus-seed/model.ts";
import { installSeedSource } from "../../src/server/corpus-seed/source-installer.ts";

const fixture = resolve("tests/fixtures/corpus-seed");

test("synthetic approved input validates with provenance and stable digests", async () => {
  const prepared = await prepareSeed(join(fixture, "plan.json"), join(fixture, "inputs.json"));
  assert.equal(prepared.slots[0].discovered, 1);
  assert.match(prepared.planDigest, /^[0-9a-f]{64}$/);
  assert.match(prepared.inputDigest, /^[0-9a-f]{64}$/);
  assert.equal(prepared.slots[0].manifestDigest, "0899a8636745a274aa0da39782d27f5435dfcdfb425b053c6bfbb539d6e9a024");
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
  await installSeedSource(prepared.slots[0], fileId, dataRoot);
  await installSeedSource(prepared.slots[0], fileId, dataRoot);
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

function fakeDependencies() {
  const state = { completed: false, failed: false, diffCalls: 0, publicationCalls: 0 };
  const sourceRow = {
    id: "10000000-0000-4000-8000-000000000001", title: "Synthetic 2024 Glossary", category: "core_rules", edition: "5.5e", language: "en",
    access_tier: "open", publication_code: "SYN-2024", publisher: "Test Fixture Authors", release_year: 2024,
    publication_revision: "synthetic-v1", external_origin_url: "https://next.dnd.su/glossary/", external_origin_id: "synthetic-fixture",
    attribution: "Synthetic fixture authored for this repository.", canonical_book_id: "synthetic-glossary", license: "CC0-1.0 synthetic fixture",
    metadata: { corpusSeed: { slotId: "glossary", licenseApproval: { approvedBy: "test-suite", approvedAt: "2026-08-08T00:00:00.000Z", evidenceReference: "repository:test-fixture" } } },
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
