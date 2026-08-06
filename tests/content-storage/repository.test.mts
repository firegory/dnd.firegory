import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  activationDeltaPath,
  canonicalJson,
  canonicalRevisionPath,
  contentHash,
  createCanonicalRevision,
  exportPath,
  formatPublicationGeneration,
  generationPath,
  getDataRoot,
  hasValidRevisionIdentity,
  repositoryBootstrapPath,
  parsePublicationGeneration,
  revisionIdentity,
  schemaPath,
  snapshotPath,
  sourcePdfPath,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type ContentSource,
} from "../../src/server/content-storage/repository.ts";
import {
  assertCanonicalRevision,
  assertContentSource,
  assertRepositoryActivationDelta,
  assertRepositoryManifest,
  ContentIntegrityError,
  ContentSchemaValidationError,
  loadRepositoryBootstrapDescriptor,
  validateContentRepository,
} from "../../src/server/content-storage/validation.ts";
import {
  contentSourceFromMetadataRecord,
  sourceMetadataInputFromContentSource,
} from "../../src/server/content/source-projection.ts";
import {
  ContentMetadataValidationError,
  normalizeSourceInput,
  type SourceMetadataRecord,
} from "../../src/server/content/metadata.ts";
import { validateIngestionArgs } from "../../src/cli/validate-args.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const dataRoot = resolve(repositoryRoot, "content-repository");
const schemasRoot = resolve(dataRoot, "schemas/v1");
const ownerUserId = "11111111-1111-4111-8111-111111111111";

test("repository paths are deterministic for stable IDs", () => {
  const revisionId = `rev-${"a".repeat(64)}`;
  const paths = () => [
    repositoryBootstrapPath(dataRoot),
    schemaPath(dataRoot, "canonical-revision"),
    sourcePdfPath(dataRoot, "srd-2014", "basic-rules"),
    canonicalRevisionPath(dataRoot, "dash", revisionId),
    generationPath(dataRoot, "search-index-1"),
    snapshotPath(dataRoot, "release-1"),
    exportPath(dataRoot, "website-1"),
    activationDeltaPath(dataRoot, formatPublicationGeneration(BigInt(42))),
  ];

  assert.deepEqual(paths(), paths());
  assert.equal(paths()[3], resolve(dataRoot, "compendium/dash/revisions", `${revisionId}.json`));
  assert.equal(paths()[7], resolve(dataRoot, "manifests/activations/00000000000000000000000000000042.json"));
  assert.equal(parsePublicationGeneration("00000000000000000000000000000042"), BigInt(42));
});

test("repository paths reject traversal and ambiguous IDs", () => {
  const revisionId = `rev-${"a".repeat(64)}`;
  assert.throws(() => sourcePdfPath(dataRoot, "../private", "source"), /stable ID/);
  assert.throws(() => canonicalRevisionPath(dataRoot, "dash/other", revisionId), /stable ID/);
  assert.throws(() => canonicalRevisionPath(dataRoot, "dash", "latest"), /SHA-256/);
  assert.throws(() => schemaPath(dataRoot, "entry", 0), /positive integer/);
  assert.throws(() => activationDeltaPath(dataRoot, "42"), /fixed-width/);
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

test("all checked schemas and the complete data-root repository validate", async () => {
  const schemaFiles = (await readdir(schemasRoot)).filter((name) => name.endsWith(".schema.json"));
  const schemas = await Promise.all(schemaFiles.map((name) => readJson(resolve(schemasRoot, name))));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);

  for (const schema of schemas) assert.equal(ajv.validateSchema(schema), true, ajv.errorsText());
  for (const schema of schemas) ajv.addSchema(schema);

  const source = await readJson(resolve(dataRoot, "sources/srd-2014/source.json"));
  assert.equal(ajv.validate("urn:dnd-firegory:schema:content-repository:source:1", source), true, ajv.errorsText());
  assertContentSource(source);

  const manifest = await loadManifest();
  assertRepositoryManifest(manifest);
  for (const entry of manifest.entries) {
    const revision = await readJson(resolveDataRootPath(entry.path));
    assertCanonicalRevision(revision);
  }
  await validateContentRepository(dataRoot);
});

test("unknown and malformed schema versions are rejected for every document type", async (t) => {
  const manifest = await loadManifest();
  const revision = await readJson(resolveDataRootPath(manifest.entries[0].path));
  const source = await readJson(resolve(dataRoot, "sources/srd-2014/source.json"));
  const documents = [
    ["source", source, assertContentSource],
    ["revision", revision, assertCanonicalRevision],
    ["manifest", manifest, assertRepositoryManifest],
  ] as const;

  for (const [name, document, validate] of documents) {
    for (const schemaVersion of [2, "1", null]) {
      await t.test(`${name} rejects schemaVersion ${String(schemaVersion)}`, () => {
        assert.throws(() => validate({ ...(document as object), schemaVersion }), ContentSchemaValidationError);
      });
    }
  }
});

test("delta-fold reader contract requires explicit version one", async (t) => {
  const manifest = await loadRepositoryBootstrapDescriptor(dataRoot);
  assert.equal(manifest.readerContractVersion, 1);
  const delta = {
    schemaVersion: 1,
    kind: "repositoryActivationDelta",
    readerContractVersion: 1,
    generation: formatPublicationGeneration(BigInt(1)),
    idempotencyKey: "contract-test",
    targetEntryId: manifest.entries[0].entryId,
    entry: manifest.entries[0],
  } as const;
  assert.doesNotThrow(() => assertRepositoryActivationDelta(delta));
  assert.throws(() => assertRepositoryActivationDelta({ ...delta, readerContractVersion: 2 }), ContentSchemaValidationError);
  const unversioned = { ...delta } as Record<string, unknown>;
  delete unversioned.readerContractVersion;
  assert.throws(() => assertRepositoryActivationDelta(unversioned), ContentSchemaValidationError);

  for (const contractVersion of [2, "1", null, undefined]) {
    await t.test(`bootstrap rejects reader contract ${String(contractVersion)}`, async (st) => {
      const root = await temporaryRepository(st);
      const bootstrap = await readJson(repositoryBootstrapPath(root)) as Record<string, unknown>;
      if (contractVersion === undefined) delete bootstrap.readerContractVersion;
      else bootstrap.readerContractVersion = contractVersion;
      await writeJson(repositoryBootstrapPath(root), bootstrap);
      await assert.rejects(() => loadRepositoryBootstrapDescriptor(root), ContentSchemaValidationError);
    });
  }
});

test("source authorization metadata enforces current access invariants", async () => {
  const open = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  assertContentSource(open);
  assert.doesNotThrow(() => assertContentSource({ ...open, accessTier: "premium", shared: true }));
  assert.doesNotThrow(() =>
    assertContentSource({ ...open, accessTier: "personal", shared: false, ownerUserId }),
  );

  const invalid = [
    { ...open, accessTier: "open", shared: true },
    { ...open, accessTier: "open", ownerUserId },
    { ...open, accessTier: "premium", shared: false },
    { ...open, accessTier: "premium", ownerUserId, shared: true },
    { ...open, accessTier: "personal", ownerUserId: null },
    { ...open, accessTier: "personal", ownerUserId, shared: true },
  ];
  for (const source of invalid) assert.throws(() => assertContentSource(source), ContentSchemaValidationError);
});

test("source publication metadata round-trips through the database projection", async () => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const normalized = normalizeSourceInput(sourceMetadataInputFromContentSource(source));
  const record: SourceMetadataRecord = {
    id: "00000000-0000-0000-0000-000000000001",
    ...normalized,
    createdByUserId: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    deletedAt: null,
  };

  assert.deepEqual(contentSourceFromMetadataRecord(record, source.files), source);
});

test("source schema rejects contradictory publication metadata", async () => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  assert.throws(
    () => assertContentSource({ ...source, edition: "5.5e", publication: { ...source.publication, releaseYear: 2014 } }),
    ContentSchemaValidationError,
  );
  assert.throws(
    () => assertContentSource({
      ...source,
      publication: { ...source.publication, origin: { url: "file:///book", id: "book" } },
    }),
    ContentSchemaValidationError,
  );
});

test("canonical schema and runtime agree on every publication field contract", async (t) => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  assertContentSource(source);
  assert.doesNotThrow(() => normalizeSourceInput(sourceMetadataInputFromContentSource(source)));

  const malformed = [
    ["code", (value: MutableSource) => { value.publication.code = " "; }],
    ["title", (value: MutableSource) => { value.publication.title = " \t "; }],
    ["publisher", (value: MutableSource) => { value.publication.publisher = "\n"; }],
    ["releaseYear", (value: MutableSource) => { value.publication.releaseYear = 1973; }],
    ["revision", (value: MutableSource) => { value.publication.revision = " "; }],
    ["origin URL", (value: MutableSource) => { value.publication.origin.url = "ftp://example.com/book"; }],
    ["origin ID", (value: MutableSource) => { value.publication.origin.id = " "; }],
    ["attribution", (value: MutableSource) => { value.publication.attribution = " "; }],
    ["sourcePriority", (value: MutableSource) => { value.publication.sourcePriority = -1; }],
    ["canonicalBookId", (value: MutableSource) => { value.publication.canonicalBookId = "Not Stable"; }],
    ["license", (value: MutableSource) => { value.license = " "; }],
  ] as const;

  for (const [field, mutateSource] of malformed) {
    await t.test(field, () => {
      const candidate = structuredClone(source) as unknown as MutableSource;
      mutateSource(candidate);
      assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
      assert.throws(() => normalizeSourceInput(sourceMetadataInputFromContentSource(candidate as unknown as ContentSource)), ContentMetadataValidationError);
    });
  }
});

test("canonical HTTP(S) URL vectors round-trip identically", async (t) => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const canonicalUrls = [
    "http://example.com/",
    "http://example.com:8080/books/basic-rules",
    "https://example.com/",
    "https://example.com/books/basic-rules",
    "https://example.com/a%20book?q=rules#section",
    "https://example.com:8443/path",
  ];
  for (const url of canonicalUrls) {
    await t.test(`accepts ${url}`, () => {
      const candidate = sourceWithOriginUrl(source, url);
      assertContentSource(candidate);
      assert.equal(runtimeOriginUrl(candidate), url);
    });
  }

  const invalidUrls = [
    "ftp://example.com/book",
    "//example.com/book",
    "/relative/book",
    "https://",
    "https:///missing-authority",
    " https://example.com/book",
    "https://example.com/book ",
    "https://example.com/a b",
    "https://example.com/%",
    "https://example.com/%2",
    "https://example.com/%GG",
    "https://%65xample.com/book",
  ];
  for (const url of invalidUrls) {
    await t.test(`rejects ${url}`, () => {
      const candidate = sourceWithOriginUrl(source, url);
      assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
      assert.throws(() => runtimeOriginUrl(candidate), ContentMetadataValidationError);
    });
  }
});

test("noncanonical HTTP(S) inputs normalize before persistence and canonical files reject them", async (t) => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const vectors = [
    ["http://example.com", "http://example.com/"],
    ["https://example.com", "https://example.com/"],
    ["http://example.com:80/path", "http://example.com/path"],
    ["https://example.com:443/path", "https://example.com/path"],
    ["https://EXAMPLE.COM/path", "https://example.com/path"],
    ["https://example.com/a/../b", "https://example.com/b"],
  ] as const;

  for (const [input, expected] of vectors) {
    await t.test(input, () => {
      const candidate = sourceWithOriginUrl(source, input);
      assert.throws(
        () => assertContentSource(candidate),
        (error: unknown) => error instanceof ContentIntegrityError
          && /canonical WHATWG-normalized spelling/.test(error.message),
      );
      assert.equal(candidate.publication.origin?.url, input);
      const normalizedUrl = runtimeOriginUrl(candidate);
      assert.equal(normalizedUrl, expected);
      assertContentSource(sourceWithOriginUrl(source, normalizedUrl));
    });
  }
});

test("case-normalizable HTTP(S) input produces a schema-valid canonical value", async () => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const candidate = sourceWithOriginUrl(source, "HTTP://EXAMPLE.COM/books/basic-rules");

  assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
  const normalizedUrl = runtimeOriginUrl(candidate);
  assert.equal(normalizedUrl, "http://example.com/books/basic-rules");
  assertContentSource(sourceWithOriginUrl(source, normalizedUrl));
});

test("CLI, runtime, and schema share plain UUID ownership rules", async () => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const personal = { ...source, accessTier: "personal" as const, shared: false, ownerUserId };
  assertContentSource(personal);
  assert.equal(normalizeSourceInput(sourceMetadataInputFromContentSource(personal)).ownerUserId, ownerUserId);
  assert.equal(validateIngestionArgs(cliInput("personal", ownerUserId)).ownerUserId, ownerUserId);

  for (const invalidOwner of ["user-uuid-123", `urn:uuid:${ownerUserId}`, ` ${ownerUserId} `]) {
    const candidate = { ...personal, ownerUserId: invalidOwner };
    assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
    assert.throws(
      () => normalizeSourceInput(sourceMetadataInputFromContentSource(candidate as ContentSource)),
      ContentMetadataValidationError,
    );
    assert.throws(() => validateIngestionArgs(cliInput("personal", invalidOwner)), /plain UUID/);
  }

  for (const accessTier of ["open", "premium"] as const) {
    const candidate = { ...source, accessTier, shared: accessTier === "premium", ownerUserId };
    assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
    assert.throws(
      () => normalizeSourceInput(sourceMetadataInputFromContentSource(candidate as ContentSource)),
      ContentMetadataValidationError,
    );
    assert.throws(() => validateIngestionArgs(cliInput(accessTier, ownerUserId)), /not allowed/);
  }
});

test("canonical schema and runtime agree on source identity and corpus fields", async (t) => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  const malformed = [
    ["sourceId", (value: MutableSource) => { value.sourceId = "Not Stable"; }],
    ["source title", (value: MutableSource) => { value.title = " "; }],
    ["category", (value: MutableSource) => { value.category = "invalid"; }],
    ["edition", (value: MutableSource) => { value.edition = "4e"; }],
    ["language", (value: MutableSource) => { value.language = "de"; }],
    ["accessTier", (value: MutableSource) => { value.accessTier = "private"; }],
    ["ownerUserId", (value: MutableSource) => {
      value.accessTier = "personal";
      value.shared = false;
      value.ownerUserId = "user-1";
    }],
  ] as const;

  for (const [field, mutateSource] of malformed) {
    await t.test(field, () => {
      const candidate = structuredClone(source) as unknown as MutableSource;
      mutateSource(candidate);
      assert.throws(() => assertContentSource(candidate), ContentSchemaValidationError);
      assert.throws(() => normalizeSourceInput(sourceMetadataInputFromContentSource(candidate as unknown as ContentSource)), ContentMetadataValidationError);
    });
  }
});

test("canonical validation rejects content that does not match its hashes", async () => {
  const manifest = await loadManifest();
  const revision = await readJson(resolveDataRootPath(manifest.entries[0].path));

  assert.throws(
    () => assertCanonicalRevision({ ...(revision as CanonicalRevision), entryId: "tampered" }),
    ContentIntegrityError,
  );
});

test("canonical semantic validation rejects malformed spans and references", async () => {
  const manifest = await loadManifest();
  const original = (await readJson(resolveDataRootPath(manifest.entries[0].path))) as CanonicalRevision;
  const malformed: CanonicalRevision[] = [];

  malformed.push(resignRevision(mutate(original, (value) => { value.text.sections[0].endOffset = 999; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.text.sections[0].text = "Different text"; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.text.sections[0].startOffset = 1; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.citations[0].quote = "Different quote"; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.citations[0].sourceId = "other-source"; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.citations[0].fileId = "other-file"; })));
  malformed.push(resignRevision(mutate(original, (value) => { value.citations.push({ ...value.citations[0] }); })));
  malformed.push(resignRevision(mutate(original, (value) => { value.entry.typedFields.push({ ...value.entry.typedFields[0] }); })));

  for (const revision of malformed) assert.throws(() => assertCanonicalRevision(revision), ContentIntegrityError);
});

test("source validation rejects duplicate stable file identifiers", async () => {
  const source = (await readJson(resolve(dataRoot, "sources/srd-2014/source.json"))) as ContentSource;
  assert.throws(
    () => assertContentSource({ ...source, files: [...source.files, source.files[0]] }),
    ContentIntegrityError,
  );
});

test("repository validation rejects nondeterministic paths and manifest mismatches", async (t) => {
  const nondeterministicRoot = await temporaryRepository(t);
  const nondeterministicManifest = await loadManifestFrom(nondeterministicRoot);
  nondeterministicManifest.entries[0].path = "compendium/dash/revisions/alias.json";
  await writeJson(repositoryBootstrapPath(nondeterministicRoot), nondeterministicManifest);
  await assert.rejects(() => validateContentRepository(nondeterministicRoot), /deterministic canonical path/);

  const mismatchRoot = await temporaryRepository(t);
  const mismatchManifest = await loadManifestFrom(mismatchRoot);
  mismatchManifest.entries[0].contentHash = `sha256:${"0".repeat(64)}`;
  await writeJson(repositoryBootstrapPath(mismatchRoot), mismatchManifest);
  await assert.rejects(() => validateContentRepository(mismatchRoot), /Manifest metadata/);
});

test("repository validation verifies declared schema IDs and source bytes", async (t) => {
  const schemaRoot = await temporaryRepository(t);
  const schemaFile = resolve(schemaRoot, "schemas/v1/source.schema.json");
  const schema = await readJson(schemaFile) as Record<string, unknown>;
  schema.$id = "urn:dnd-firegory:schema:content-repository:wrong:1";
  await writeJson(schemaFile, schema);
  await assert.rejects(() => validateContentRepository(schemaRoot), /referenced schema \$id/);

  const sourceRoot = await temporaryRepository(t);
  await writeFile(resolve(sourceRoot, "sources/srd-2014/files/basic-rules-excerpt.txt"), "tampered\n");
  await assert.rejects(() => validateContentRepository(sourceRoot), /does not match its contentHash/);
});

test("repository validation rejects symlinks that escape DND_DATA_ROOT", async (t) => {
  const root = await temporaryRepository(t);
  const manifest = await loadManifestFrom(root);
  const revisionPath = resolve(root, manifest.entries[0].path);
  const outsidePath = resolve(dirname(root), "outside-revision.json");
  await writeFile(outsidePath, await readFile(revisionPath));
  await rm(revisionPath);

  try {
    await symlink(outsidePath, revisionPath);
  } catch (error) {
    if (isUnsupportedSymlinkError(error)) {
      t.skip("Filesystem does not permit creating symbolic links.");
      return;
    }
    throw error;
  }

  await assert.rejects(() => validateContentRepository(root), /escapes DND_DATA_ROOT/);
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
    ...(await filesRecursively(dataRoot)),
    resolve(repositoryRoot, ".env.example"),
    resolve(repositoryRoot, "docker-compose.yml"),
    resolve(repositoryRoot, "README.md"),
  ];
  const forbidden = /(?:nfs:\/\/|NFS_(?:HOST|SERVER|EXPORT|USER|PASSWORD)|type:\s*nfs|mountOptions|o:\s*addr=|device:\s*:[/\\])/i;

  for (const file of contractFiles) {
    assert.doesNotMatch(await readFile(file, "utf8"), forbidden, file);
  }
});

async function loadManifest(): Promise<{
  entries: Array<{ entryId: string; revisionId: string; path: string; contentHash: string }>;
}> {
  return (await readJson(repositoryBootstrapPath(dataRoot))) as Awaited<ReturnType<typeof loadManifest>>;
}

type MutableManifest = {
  entries: Array<{ entryId: string; revisionId: string; path: string; contentHash: string }>;
};

async function loadManifestFrom(root: string): Promise<MutableManifest> {
  return await readJson(repositoryBootstrapPath(root)) as MutableManifest;
}

function resolveDataRootPath(relativePath: string): string {
  const resolved = resolve(dataRoot, relativePath);
  if (!resolved.startsWith(`${dataRoot}/`)) throw new Error("Data-root path escaped the repository.");
  return resolved;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function temporaryRepository(t: TestContext): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "dnd-content-repository-"));
  const root = resolve(parent, "data-root");
  await cp(dataRoot, root, { recursive: true });
  t.after(() => rm(parent, { recursive: true, force: true }));
  return root;
}

async function filesRecursively(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) files.push(...await filesRecursively(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function isUnsupportedSymlinkError(error: unknown): boolean {
  return error instanceof Error && "code" in error && ["EPERM", "EACCES", "ENOSYS"].includes(String(error.code));
}

type MutableRevision = {
  text: { sections: Array<{ text: string; startOffset: number; endOffset: number }> };
  citations: Array<{ sourceId: string; fileId: string; quote: string }>;
  entry: { typedFields: Array<Record<string, unknown>> };
};

type MutableSource = {
  sourceId: string;
  title: string;
  category: string;
  edition: string;
  language: string;
  accessTier: string;
  shared: boolean;
  ownerUserId: string | null;
  publication: {
    code: string;
    title: string;
    publisher: string;
    releaseYear: number;
    revision: string;
    origin: { url: string; id: string };
    attribution: string;
    sourcePriority: number;
    canonicalBookId: string;
  };
  license: string;
};

function sourceWithOriginUrl(source: ContentSource, url: string): ContentSource {
  return {
    ...source,
    publication: {
      ...source.publication,
      origin: { ...source.publication.origin!, url },
    },
  };
}

function runtimeOriginUrl(source: ContentSource): string {
  const normalized = normalizeSourceInput(sourceMetadataInputFromContentSource(source));
  return normalized.publication.origin?.url ?? "";
}

function cliInput(access: "open" | "premium" | "personal", owner?: string) {
  return {
    pdf: "/tmp/book.pdf",
    title: "Book",
    category: "core_rules",
    edition: "5e",
    language: "en",
    access,
    ...(owner === undefined ? {} : { ownerUserId: owner }),
  };
}

function mutate(revision: CanonicalRevision, mutation: (value: MutableRevision) => void): CanonicalRevision {
  const value = structuredClone(revision) as unknown as MutableRevision;
  mutation(value);
  return value as unknown as CanonicalRevision;
}

function resignRevision(revision: CanonicalRevision): CanonicalRevision {
  const input = structuredClone(revision) as Partial<CanonicalRevision>;
  delete input.revisionId;
  delete input.contentHash;
  return createCanonicalRevision(input as CanonicalRevisionInput);
}

function canonicalInput() {
  return {
    schemaVersion: 1 as const,
    kind: "canonicalRevision" as const,
    entryId: "dash",
    createdAt: "2026-08-06T00:00:00.000Z",
    source: {
      schemaVersion: 1 as const,
      kind: "source" as const,
      sourceId: "srd-2014",
      title: "Basic Rules",
      category: "core_rules" as const,
      edition: "5e" as const,
      language: "en" as const,
      accessTier: "open" as const,
      shared: false,
      ownerUserId: null,
      publication: {
        code: "BR-2014",
        title: "Basic Rules",
        publisher: "Publisher",
        releaseYear: 2014,
        sourcePriority: 100,
        canonicalBookId: "basic-rules",
      },
      files: [{
        fileId: "rules",
        path: "sources/srd-2014/files/rules.pdf",
        mediaType: "application/pdf",
        contentHash: `sha256:${"0".repeat(64)}`,
      }],
    },
    entry: { name: "Dash" },
    text: { plain: "Complete text" },
    citations: [{ citationId: "citation-1" }],
  };
}
