import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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
  assert.equal(latest.kind, "corpusExportLatestDescriptor");
  assert.equal(latest.readerContractVersion, 1);
  assert.equal(latest.recordsPath, "latest");
  const pointerNames = await readdir(resolve(root, "exports/latest"));
  assert.deepEqual(pointerNames, ["00000000000000000000000000000001.json"]);
  const pointer = JSON.parse(await readFile(resolve(root, "exports/latest", pointerNames[0]), "utf8")) as Record<string, unknown>;
  assert.equal(pointer.exportId, first.exportId);
  assert.equal(pointer.path, `${first.exportId}/manifest.json`);
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

test("published validation ignores corrupt higher pointer records", async (t) => {
  const root = await temporaryRepository(t);
  const generated = await generateCorpusExport({ dataRoot: root });
  await writeFile(resolve(root, "exports/latest/00000000000000000000000000000002.json"), "{corrupt\n");
  const latest = await validatePublishedCorpusExport(root);
  assert.equal(latest.manifest.exportId, generated.exportId);

  const original = await activeRevision(root, "dash");
  const updated = revised(original, "dash", "After corrupt pointer");
  await installRevision(root, updated, [{ entryId: updated.entryId, revisionId: updated.revisionId, contentHash: updated.contentHash, path: revisionPath(updated) }]);
  const recovered = await generateCorpusExport({ dataRoot: root });
  assert.deepEqual((await readdir(resolve(root, "exports/latest"))).filter((name) => /^[0-9]{32}\.json$/.test(name)), [
    "00000000000000000000000000000001.json",
    "00000000000000000000000000000002.json",
    "00000000000000000000000000000003.json",
  ]);
  assert.equal((await validatePublishedCorpusExport(root)).manifest.exportId, recovered.exportId);
});

test("crashed pointer preparation and abandoned legacy lock cannot block later publication", async (t) => {
  const root = await temporaryRepository(t);
  await generateCorpusExport({ dataRoot: root });
  const original = await activeRevision(root, "dash");
  const updated = revised(original, "dash", "After crash");
  await installRevision(root, updated, [{ entryId: updated.entryId, revisionId: updated.revisionId, contentHash: updated.contentHash, path: revisionPath(updated) }]);

  await assert.rejects(() => generateCorpusExport({
    dataRoot: root,
    afterLatestRecordPrepared: () => { throw new Error("simulated process death"); },
  }), /simulated process death/);
  await writeFile(resolve(root, "exports/latest/.crashed-writer.tmp"), "partial");
  await mkdir(resolve(root, "exports/.latest.lock"));

  const recovered = await generateCorpusExport({ dataRoot: root });
  const latest = await validatePublishedCorpusExport(root);
  assert.equal(latest.manifest.exportId, recovered.exportId);
  assert.deepEqual((await readdir(resolve(root, "exports/latest"))).filter((name) => /^[0-9]{32}\.json$/.test(name)), [
    "00000000000000000000000000000001.json",
    "00000000000000000000000000000002.json",
  ]);
});

test("incremental validation recomputes predecessor diff and verifies previous hashes", async (t) => {
  const root = await temporaryRepository(t);
  await generateCorpusExport({ dataRoot: root });
  const original = await activeRevision(root, "dash");
  const updated = revised(original, "dash", "Updated once");
  await installRevision(root, updated, [{ entryId: updated.entryId, revisionId: updated.revisionId, contentHash: updated.contentHash, path: revisionPath(updated) }]);
  const generated = await generateCorpusExport({ dataRoot: root });

  const changes = JSON.parse(await readFile(resolve(generated.path, "changes.json"), "utf8")) as Record<string, unknown>;
  changes.updates = [];
  const forgedDiffPath = await rewriteIdentityBoundArtifacts(generated.path, {
    "changes.json": `${canonicalJson(changes as JsonValue)}\n`,
    "changes.jsonl": "",
  });
  await assert.rejects(() => validateCorpusExport(forgedDiffPath), /actual predecessor catalog diff/);

  const secondRoot = await temporaryRepository(t);
  await generateCorpusExport({ dataRoot: secondRoot });
  const secondOriginal = await activeRevision(secondRoot, "dash");
  const secondUpdated = revised(secondOriginal, "dash", "Updated twice");
  await installRevision(secondRoot, secondUpdated, [{ entryId: secondUpdated.entryId, revisionId: secondUpdated.revisionId, contentHash: secondUpdated.contentHash, path: revisionPath(secondUpdated) }]);
  const regenerated = await generateCorpusExport({ dataRoot: secondRoot });
  const record = JSON.parse((await readFile(resolve(regenerated.path, "changes.jsonl"), "utf8")).trim()) as Record<string, unknown>;
  record.previousContentHash = `sha256:${"0".repeat(64)}`;
  const forgedHashPath = await rewriteIdentityBoundArtifacts(regenerated.path, {
    "changes.jsonl": `${canonicalJson(record as JsonValue)}\n`,
  });
  await assert.rejects(() => validateCorpusExport(forgedHashPath), /previous identity/);
});

test("validation requires canonical JSON bytes and rejects unknown fields", async (t) => {
  await t.test("noncanonical JSON bytes", async (st) => {
    const root = await temporaryRepository(st);
    const generated = await generateCorpusExport({ dataRoot: root });
    const sourcesPath = resolve(generated.path, "sources.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
    const noncanonical = `${JSON.stringify(sources, null, 2)}\n`;
    await writeFile(sourcesPath, noncanonical);
    await rehashArtifact(generated.path, "sources.json", noncanonical);
    await assert.rejects(() => validateCorpusExport(generated.path), /not canonical JSON/);
  });

  await t.test("unknown output fields", async (st) => {
    const root = await temporaryRepository(st);
    const generated = await generateCorpusExport({ dataRoot: root });
    const sourcesPath = resolve(generated.path, "sources.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as Record<string, JsonValue>;
    sources.unexpected = true;
    const contents = `${canonicalJson(sources)}\n`;
    await writeFile(sourcesPath, contents);
    await rehashArtifact(generated.path, "sources.json", contents);
    await assert.rejects(() => validateCorpusExport(generated.path), /missing or unknown fields/);
  });

  await t.test("noncanonical JSONL bytes", async (st) => {
    const root = await temporaryRepository(st);
    const generated = await generateCorpusExport({ dataRoot: root });
    const entriesPath = resolve(generated.path, "entries.jsonl");
    const entry = JSON.parse((await readFile(entriesPath, "utf8")).trim());
    const noncanonical = `${JSON.stringify(entry).replace("{", "{ ")}\n`;
    await writeFile(entriesPath, noncanonical);
    await rehashArtifact(generated.path, "entries.jsonl", noncanonical);
    await assert.rejects(() => validateCorpusExport(generated.path), /not canonical JSON/);
  });
});

test("validation rejects symlinked export directories and artifacts", async (t) => {
  const root = await temporaryRepository(t);
  const generated = await generateCorpusExport({ dataRoot: root });
  const alias = resolve(root, "exports", `corpus-${"a".repeat(64)}`);
  await symlink(generated.path, alias, "dir");
  await assert.rejects(() => validateCorpusExport(alias), /no-follow directory/);

  const readmePath = resolve(generated.path, "README.md");
  const external = resolve(root, "outside-readme.md");
  await writeFile(external, await readFile(readmePath));
  await rm(readmePath);
  await symlink(external, readmePath);
  await assert.rejects(() => validateCorpusExport(generated.path), /no-follow regular file/);
});

test("Markdown display metadata HTML-encodes raw HTML and escapes Markdown", async (t) => {
  const root = await temporaryRepository(t);
  const original = await activeRevision(root, "dash");
  const hostile = `<script>*bold*</script> & "quoted" 'single'`;
  const source = {
    ...original.source,
    title: hostile,
    publication: { ...original.source.publication, title: hostile },
  };
  const revision = createCanonicalRevision({
    schemaVersion: original.schemaVersion,
    kind: original.kind,
    entryId: original.entryId,
    createdAt: original.createdAt,
    source,
    entry: { ...original.entry, name: hostile },
    text: original.text,
    citations: original.citations,
  } as CanonicalRevisionInput);
  await writeFile(resolve(root, `sources/${source.sourceId}/source.json`), `${JSON.stringify(source, null, 2)}\n`);
  await installRevision(root, revision, [{ entryId: revision.entryId, revisionId: revision.revisionId, contentHash: revision.contentHash, path: revisionPath(revision) }]);
  const generated = await generateCorpusExport({ dataRoot: root });
  const markdown = await readFile(resolve(generated.path, "entries.md"), "utf8");
  const heading = markdown.split("\n").find((line) => line.startsWith("## "))!;
  const sourceLine = markdown.split("\n").find((line) => line.startsWith("Source: "))!;
  for (const line of [heading, sourceLine]) {
    assert.doesNotMatch(line, /<script>/);
    assert.match(line, /&lt;script&gt;\\\*bold\\\*&lt;\/script&gt;/);
    assert.match(line, /&amp; &quot;quoted&quot; &#39;single&#39;/);
  }
});

test("a paused older generator cannot regress latest after a newer snapshot publishes", async (t) => {
  const root = await temporaryRepository(t);
  const initial = await generateCorpusExport({ dataRoot: root });
  const original = await activeRevision(root, "dash");
  const older = revised(original, "dash", "Older snapshot");
  await installRevision(root, older, [{ entryId: older.entryId, revisionId: older.revisionId, contentHash: older.contentHash, path: revisionPath(older) }]);

  let releaseOlder!: () => void;
  let reportPaused!: () => void;
  const paused = new Promise<void>((resolvePaused) => { reportPaused = resolvePaused; });
  const release = new Promise<void>((resolveRelease) => { releaseOlder = resolveRelease; });
  const olderGeneration = generateCorpusExport({
    dataRoot: root,
    afterLatestRecordPrepared: async () => {
      reportPaused();
      await release;
    },
  });
  await paused;

  const newer = revised(original, "dash", "Newer snapshot");
  await installRevision(root, newer, [{ entryId: newer.entryId, revisionId: newer.revisionId, contentHash: newer.contentHash, path: revisionPath(newer) }]);
  const newerGeneration = await generateCorpusExport({ dataRoot: root });
  releaseOlder();
  await assert.rejects(olderGeneration, /advanced before/);

  const latest = await validatePublishedCorpusExport(root);
  assert.equal(latest.manifest.exportId, newerGeneration.exportId);
  assert.notEqual(latest.manifest.exportId, initial.exportId);
});

test("CLI generates and validates exports without database connectivity", async (t) => {
  const root = await temporaryRepository(t);
  const environment = { ...process.env, DND_DATA_ROOT: root, DATABASE_URL: "postgresql://unreachable.invalid/no-db" };
  const generated = await execute(process.execPath, ["--experimental-strip-types", "scripts/corpus-export.mts", "generate"], { env: environment });
  const result = JSON.parse(generated.stdout) as { exportId: string; catalogHash: string; changes: { additions: number } };
  assert.match(result.exportId, /^corpus-[0-9a-f]{64}$/);
  assert.equal(result.changes.additions, 1);
  const validated = await execute(process.execPath, ["--experimental-strip-types", "scripts/corpus-export.mts", "validate"], { env: environment });
  assert.deepEqual(JSON.parse(validated.stdout), { exportId: result.exportId, catalogHash: result.catalogHash, valid: true });
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

async function rehashArtifact(exportPath: string, artifactName: string, contents: string): Promise<void> {
  const manifestPath = resolve(exportPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    artifacts: Array<{ path: string; contentHash: string; byteSize: number }>;
  };
  const artifact = manifest.artifacts.find((candidate) => candidate.path === artifactName)!;
  artifact.contentHash = sha256(contents);
  artifact.byteSize = Buffer.byteLength(contents);
  await writeFile(manifestPath, `${canonicalJson(manifest as unknown as JsonValue)}\n`);
}

async function rewriteIdentityBoundArtifacts(exportPath: string, updates: Record<string, string>): Promise<string> {
  for (const [name, contents] of Object.entries(updates)) await writeFile(resolve(exportPath, name), contents);
  const manifestPath = resolve(exportPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, JsonValue> & {
    artifacts: Array<{ path: string; contentHash: string; byteSize: number }>;
  };
  for (const [name, contents] of Object.entries(updates)) {
    const artifact = manifest.artifacts.find((candidate) => candidate.path === name)!;
    artifact.contentHash = sha256(contents);
    artifact.byteSize = Buffer.byteLength(contents);
    if (name === "changes.json") manifest.changesHash = artifact.contentHash;
    if (name === "changes.jsonl") manifest.changeRecordsHash = artifact.contentHash;
  }
  const identity = canonicalJson({
    catalogHash: manifest.catalogHash,
    changeRecordsHash: manifest.changeRecordsHash,
    changesHash: manifest.changesHash,
  } as JsonValue);
  const exportId = `corpus-${createHash("sha256").update(identity).digest("hex")}`;
  manifest.exportId = exportId;
  await writeFile(manifestPath, `${canonicalJson(manifest as JsonValue)}\n`);
  const target = resolve(dirname(exportPath), exportId);
  if (target !== exportPath) await rename(exportPath, target);
  return target;
}

function sha256(contents: string): string {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}
