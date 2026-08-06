import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  canonicalJson,
  canonicalRevisionPath,
  contentHash,
  createCanonicalRevision,
  exportPath,
  generationPath,
  getDataRoot,
  hasValidRevisionIdentity,
  manifestPath,
  revisionIdentity,
  schemaPath,
  snapshotPath,
  sourcePdfPath,
  type CanonicalRevision,
} from "../../src/server/content-storage/repository.ts";
import {
  assertCanonicalRevision,
  assertRepositoryManifest,
  ContentIntegrityError,
  ContentSchemaValidationError,
} from "../../src/server/content-storage/validation.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataRoot = resolve(repositoryRoot, "content-repository");
const schemasRoot = resolve(dataRoot, "schemas/v1");

test("repository paths are deterministic for stable IDs", () => {
  const revisionId = `rev-${"a".repeat(64)}`;
  const paths = () => [
    manifestPath(dataRoot),
    schemaPath(dataRoot, "canonical-revision"),
    sourcePdfPath(dataRoot, "srd-2014", "basic-rules"),
    canonicalRevisionPath(dataRoot, "dash", revisionId),
    generationPath(dataRoot, "search-index-1"),
    snapshotPath(dataRoot, "release-1"),
    exportPath(dataRoot, "website-1"),
  ];

  assert.deepEqual(paths(), paths());
  assert.equal(paths()[3], resolve(dataRoot, "compendium/dash/revisions", `${revisionId}.json`));
});

test("repository paths reject traversal and ambiguous IDs", () => {
  const revisionId = `rev-${"a".repeat(64)}`;
  assert.throws(() => sourcePdfPath(dataRoot, "../private", "source"), /stable ID/);
  assert.throws(() => canonicalRevisionPath(dataRoot, "dash/other", revisionId), /stable ID/);
  assert.throws(() => canonicalRevisionPath(dataRoot, "dash", "latest"), /SHA-256/);
  assert.throws(() => schemaPath(dataRoot, "entry", 0), /positive integer/);
});

test("DND_DATA_ROOT is explicit and independent of a storage server", () => {
  assert.equal(getDataRoot({ DND_DATA_ROOT: "./content-repository" }), dataRoot);
  assert.throws(() => getDataRoot({}), /DND_DATA_ROOT/);
});

test("canonical JSON and revision identities are key-order independent", () => {
  assert.equal(canonicalJson({ b: 2, a: [true, "x"] }), '{"a":[true,"x"],"b":2}');
  assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));

  const input = canonicalInput();
  const first = createCanonicalRevision(input);
  const second = createCanonicalRevision(input);
  assert.deepEqual(first, second);
  assert.deepEqual(revisionIdentity(input), {
    revisionId: first.revisionId,
    contentHash: first.contentHash,
  });
  assert.equal(hasValidRevisionIdentity(first), true);
  assert.equal(hasValidRevisionIdentity({ ...first, entryId: "changed" }), false);
});

test("all checked schemas and data-root examples validate", async () => {
  const schemaFiles = (await readdir(schemasRoot)).filter((name) => name.endsWith(".schema.json"));
  const schemas = await Promise.all(schemaFiles.map((name) => readJson(resolve(schemasRoot, name))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  for (const schema of schemas) assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
  for (const schema of schemas) ajv.addSchema(schema);

  const source = await readJson(resolve(dataRoot, "sources/srd-2014/source.json"));
  assert.equal(ajv.validate("urn:dnd-firegory:schema:content-repository:source:1", source), true, ajv.errorsText());

  const manifest = await loadManifest();
  assertRepositoryManifest(manifest);
  for (const entry of manifest.entries) {
    const revision = await readJson(resolveDataRootPath(entry.path));
    assertCanonicalRevision(revision);
  }
});

test("unknown and invalid schema versions are rejected", async () => {
  const manifest = await loadManifest();
  const revision = await readJson(resolveDataRootPath(manifest.entries[0].path));

  assert.throws(
    () => assertCanonicalRevision({ ...revision, schemaVersion: 2 }),
    ContentSchemaValidationError,
  );
  assert.throws(
    () => assertRepositoryManifest({ ...manifest, schemaVersion: "1" }),
    ContentSchemaValidationError,
  );
});

test("canonical validation rejects content that does not match its hashes", async () => {
  const manifest = await loadManifest();
  const revision = await readJson(resolveDataRootPath(manifest.entries[0].path));

  assert.throws(
    () => assertCanonicalRevision({ ...(revision as CanonicalRevision), entryId: "tampered" }),
    ContentIntegrityError,
  );
});

test("canonical example is complete and renderable from data-root files", async () => {
  const manifest = await loadManifest();
  const listed = manifest.entries[0];
  const revision = (await readJson(resolveDataRootPath(listed.path))) as CanonicalRevision;
  assertCanonicalRevision(revision);

  assert.equal(revision.entryId, listed.entryId);
  assert.equal(revision.revisionId, listed.revisionId);
  assert.equal(revision.contentHash, listed.contentHash);
  assert.equal(hasValidRevisionIdentity(revision), true);
  assert.ok(revision.text.plain);
  assert.ok(revision.entry.typedFields);
  assert.ok(revision.citations.length > 0);

  const sourceFile = revision.source.files as Array<Record<string, string>>;
  const sourceBytes = await readFile(resolveDataRootPath(sourceFile[0].path));
  const sourceHash = `sha256:${createHash("sha256").update(sourceBytes).digest("hex")}`;
  assert.equal(sourceHash, sourceFile[0].contentHash);

  for (const citation of revision.citations) {
    assert.equal(citation.sourceId, revision.source.sourceId);
    assert.ok((revision.text.plain as string).includes(citation.quote as string));
    assert.equal(
      (revision.text.plain as string).slice(citation.startOffset as number, citation.endOffset as number),
      citation.quote,
    );
  }

  const sections = revision.text.sections as Array<Record<string, string | number>>;
  assert.equal(sections.map((section) => section.text).join("\n"), revision.text.plain);
  assert.equal(sections[0].endOffset, (revision.text.plain as string).length);

  const rendered = `${revision.entry.name}\n\n${revision.text.plain}\n\nSource: ${revision.source.title}, p. ${revision.citations[0].page}`;
  assert.match(rendered, /Dash/);
  assert.match(rendered, /extra movement/);
  assert.match(rendered, /D&D Basic Rules \(2014\), p\. 72/);
});

test("portable contract contains no server endpoint or credential configuration", async () => {
  const contractFiles = [
    resolve(dataRoot, "README.md"),
    ...((await readdir(schemasRoot)).map((name) => resolve(schemasRoot, name))),
  ];
  const forbidden = /(?:nfs:\/\/|mountOptions|serverHost|exportPath|credentials|password|secretKey)/i;

  for (const file of contractFiles) {
    assert.doesNotMatch(await readFile(file, "utf8"), forbidden, file);
  }
});

async function loadManifest(): Promise<{
  entries: Array<{ entryId: string; revisionId: string; path: string; contentHash: string }>;
}> {
  return (await readJson(manifestPath(dataRoot))) as Awaited<ReturnType<typeof loadManifest>>;
}

function resolveDataRootPath(relativePath: string): string {
  const resolved = resolve(dataRoot, relativePath);
  if (!resolved.startsWith(`${dataRoot}/`)) throw new Error("Data-root path escaped the repository.");
  return resolved;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function canonicalInput() {
  return {
    schemaVersion: 1 as const,
    kind: "canonicalRevision" as const,
    entryId: "dash",
    createdAt: "2026-08-06T00:00:00.000Z",
    source: { sourceId: "srd-2014" },
    entry: { name: "Dash" },
    text: { plain: "Complete text" },
    citations: [{ citationId: "citation-1" }],
  };
}
