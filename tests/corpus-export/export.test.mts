import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";

import {
  canonicalJson,
  createCanonicalRevision,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type JsonValue,
  type RepositoryManifest,
} from "../../src/server/content-storage/repository.ts";
import { generateCorpusExport, validateCorpusExport, validatePublishedCorpusExport } from "../../src/server/corpus-export/export.ts";

const execute = promisify(execFile);
const fixtureRoot = resolve("content-repository");

test("full export is portable, deterministic, validated, and atomically published", async (t) => {
  const root = await temporaryRepository(t);
  const first = await generateCorpusExport({ dataRoot: root });
  assert.equal(first.reused, false);
  assert.deepEqual(first.changes, { additions: 1, updates: 0, removals: 0 });

  const validated = await validateCorpusExport(first.path);
  assert.equal(validated.manifest.noncanonical, true);
  assert.equal(validated.catalog.entries.length, 1);
  assert.equal(validated.catalog.schemas.length, 4);
  assert.match(validated.catalog.schemas[0].contentHash, /^sha256:[0-9a-f]{64}$/);

  const entries = await readFile(resolve(first.path, "entries.jsonl"), "utf8");
  assert.equal(entries.trimEnd().split("\n").length, 1);
  const entry = JSON.parse(entries) as { canonicalRevision: CanonicalRevision; noncanonical: boolean };
  assert.equal(entry.noncanonical, true);
  assert.equal(entry.canonicalRevision.citations[0].citationId, "dash-basic-rules");
  const markdown = await readFile(resolve(first.path, "entries.md"), "utf8");
  assert.match(markdown, /NONCANONICAL DERIVED EXPORT/);
  assert.match(markdown, /dash-basic-rules/);
  const sources = JSON.parse(await readFile(resolve(first.path, "sources.json"), "utf8")) as {
    sources: Array<{ files: Array<{ byteSize: number; contentHash: string }> }>;
  };
  assert.equal(sources.sources[0].files[0].byteSize, 144);
  assert.match(sources.sources[0].files[0].contentHash, /^sha256:/);

  const before = await exportBytes(first.path);
  const repeated = await generateCorpusExport({ dataRoot: root });
  assert.equal(repeated.reused, true);
  assert.equal(repeated.exportId, first.exportId);
  assert.deepEqual(await exportBytes(repeated.path), before);

  const latest = JSON.parse(await readFile(resolve(root, "exports/latest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(latest.noncanonical, true);
  assert.equal(latest.exportId, first.exportId);
  assert.equal(latest.path, `${first.exportId}/manifest.json`);
  assert.deepEqual((await readdir(resolve(root, "exports"))).filter((name) => name.startsWith(".")), []);
});

test("incremental exports identify updates, additions, and removal tombstones", async (t) => {
  const root = await temporaryRepository(t);
  const initial = await generateCorpusExport({ dataRoot: root });
  const original = await activeRevision(root, "dash");

  const updated = revised(original, "dash", "Dash Updated");
  await installRevision(root, updated, [{
    entryId: updated.entryId,
    revisionId: updated.revisionId,
    contentHash: updated.contentHash,
    path: revisionPath(updated),
  }]);
  const updateExport = await generateCorpusExport({ dataRoot: root });
  assert.notEqual(updateExport.exportId, initial.exportId);
  assert.deepEqual(updateExport.changes, { additions: 0, updates: 1, removals: 0 });
  let changes = JSON.parse(await readFile(resolve(updateExport.path, "changes.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(changes.updates, ["dash"]);
  assert.deepEqual(changes.from, { catalogHash: initial.catalogHash, exportId: initial.exportId });

  const jump = revised(original, "jump", "Jump");
  const manifest = await repositoryManifest(root);
  await installRevision(root, jump, [
    ...manifest.entries,
    { entryId: jump.entryId, revisionId: jump.revisionId, contentHash: jump.contentHash, path: revisionPath(jump) },
  ]);
  const additionExport = await generateCorpusExport({ dataRoot: root });
  assert.deepEqual(additionExport.changes, { additions: 1, updates: 0, removals: 0 });
  changes = JSON.parse(await readFile(resolve(additionExport.path, "changes.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(changes.additions, ["jump"]);

  const withJump = await repositoryManifest(root);
  await writeManifest(root, { ...withJump, entries: withJump.entries.filter((entry) => entry.entryId !== "dash") });
  const removalExport = await generateCorpusExport({ dataRoot: root });
  assert.deepEqual(removalExport.changes, { additions: 0, updates: 0, removals: 1 });
  const changeLines = (await readFile(resolve(removalExport.path, "changes.jsonl"), "utf8")).trimEnd().split("\n");
  assert.equal(changeLines.length, 1);
  assert.deepEqual(JSON.parse(changeLines[0]), {
    change: "removal",
    entryId: "dash",
    previousContentHash: updated.contentHash,
    previousRevisionId: updated.revisionId,
  });
  await validateCorpusExport(removalExport.path);
});

test("validation rejects a rehashed but incomplete Markdown representation", async (t) => {
  const root = await temporaryRepository(t);
  const generated = await generateCorpusExport({ dataRoot: root });
  const markdownPath = resolve(generated.path, "entries.md");
  const altered = (await readFile(markdownPath, "utf8")).replace("dash-basic-rules", "missing-citation");
  await writeFile(markdownPath, altered);

  const manifestPath = resolve(generated.path, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    artifacts: Array<{ path: string; contentHash: string; byteSize: number }>;
  };
  const artifact = manifest.artifacts.find((item) => item.path === "entries.md")!;
  artifact.byteSize = Buffer.byteLength(altered);
  artifact.contentHash = `sha256:${createHash("sha256").update(altered).digest("hex")}`;
  await writeFile(manifestPath, `${canonicalJson(manifest as unknown as JsonValue)}\n`);

  await assert.rejects(() => validateCorpusExport(generated.path), /deterministic complete rendering/);
});

test("published validation rejects a latest pointer that does not match its immutable export", async (t) => {
  const root = await temporaryRepository(t);
  await generateCorpusExport({ dataRoot: root });
  const pointerPath = resolve(root, "exports/latest.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Record<string, unknown>;
  pointer.catalogHash = `sha256:${"0".repeat(64)}`;
  await writeFile(pointerPath, `${canonicalJson(pointer as JsonValue)}\n`);
  await assert.rejects(() => validatePublishedCorpusExport(root), /pointer does not match/);
});

test("CLI generates and validates exports without database connectivity", async (t) => {
  const root = await temporaryRepository(t);
  const environment = { ...process.env, DND_DATA_ROOT: root, DATABASE_URL: "postgresql://unreachable.invalid/no-db" };
  const generated = await execute(process.execPath, ["--experimental-strip-types", "scripts/corpus-export.mts", "generate"], { env: environment });
  const result = JSON.parse(generated.stdout) as { exportId: string; changes: { additions: number } };
  assert.match(result.exportId, /^corpus-[0-9a-f]{64}$/);
  assert.equal(result.changes.additions, 1);
  const validated = await execute(process.execPath, ["--experimental-strip-types", "scripts/corpus-export.mts", "validate"], { env: environment });
  assert.deepEqual(JSON.parse(validated.stdout), { exportId: result.exportId, catalogHash: JSON.parse(await readFile(resolve(root, "exports/latest.json"), "utf8")).catalogHash, valid: true });
});

async function temporaryRepository(t: TestContext): Promise<string> {
  const parent = await mkdtemp(resolve(tmpdir(), "dnd-corpus-export-"));
  const root = resolve(parent, "repository");
  await cp(fixtureRoot, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return root;
}

async function repositoryManifest(root: string): Promise<RepositoryManifest> {
  return JSON.parse(await readFile(resolve(root, "manifests/repository.json"), "utf8")) as RepositoryManifest;
}

async function activeRevision(root: string, entryId: string): Promise<CanonicalRevision> {
  const manifest = await repositoryManifest(root);
  const entry = manifest.entries.find((candidate) => candidate.entryId === entryId)!;
  return JSON.parse(await readFile(resolve(root, entry.path), "utf8")) as CanonicalRevision;
}

function revised(original: CanonicalRevision, entryId: string, name: string): CanonicalRevision {
  return createCanonicalRevision({
    schemaVersion: original.schemaVersion,
    kind: original.kind,
    entryId,
    createdAt: original.createdAt,
    source: original.source,
    entry: { ...original.entry, name },
    text: original.text,
    citations: original.citations,
  } as CanonicalRevisionInput);
}

function revisionPath(revision: CanonicalRevision): string {
  return `compendium/${revision.entryId}/revisions/${revision.revisionId}.json`;
}

async function installRevision(root: string, revision: CanonicalRevision, entries: RepositoryManifest["entries"]): Promise<void> {
  const path = resolve(root, revisionPath(revision));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(revision, null, 2)}\n`);
  const manifest = await repositoryManifest(root);
  await writeManifest(root, { ...manifest, entries });
}

async function writeManifest(root: string, manifest: RepositoryManifest): Promise<void> {
  await writeFile(resolve(root, "manifests/repository.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function exportBytes(path: string): Promise<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const name of (await readdir(path)).sort()) output[name] = (await readFile(resolve(path, name))).toString("base64");
  return output;
}
