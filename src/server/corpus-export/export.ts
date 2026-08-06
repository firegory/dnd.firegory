import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";

import {
  canonicalJson,
  getDataRoot,
  type CanonicalRevision,
  type ContentSource,
  type JsonValue,
  type RepositoryManifest,
} from "../content-storage/repository.ts";
import {
  assertCanonicalRevision,
  ContentIntegrityError,
  loadResolvedCanonicalRevisions,
  type ValidatedSourceFile,
} from "../content-storage/validation.ts";

export const CORPUS_EXPORT_SCHEMA_VERSION = 2 as const;

const EXPORT_ID = /^corpus-[0-9a-f]{64}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_NAMES = ["README.md", "catalog.json", "changes.json", "changes.jsonl", "entries.jsonl", "entries.md", "sources.json"] as const;

type ArtifactName = typeof ARTIFACT_NAMES[number];
type CatalogEntry = Readonly<{ entryId: string; revisionId: string; contentHash: string }>;
type SchemaDeclaration = Readonly<{ schemaId: string; schemaVersion: number; path: string; contentHash: string }>;
type SourceExport = Readonly<{ source: ContentSource; files: readonly ValidatedSourceFile[] }>;

type CorpusCatalog = Readonly<{
  schemaVersion: typeof CORPUS_EXPORT_SCHEMA_VERSION;
  kind: "corpusCatalog";
  noncanonical: true;
  repositoryId: string;
  repositoryGeneration: string | null;
  resolvedManifestHash: string;
  schemas: readonly SchemaDeclaration[];
  entries: readonly CatalogEntry[];
  sources: readonly Readonly<{ sourceId: string; fileIds: readonly string[] }>[];
}>;

type ChangeManifest = Readonly<{
  schemaVersion: typeof CORPUS_EXPORT_SCHEMA_VERSION;
  kind: "corpusChangedEntryManifest";
  noncanonical: true;
  from: Readonly<{ exportId: string; catalogHash: string }> | null;
  toCatalogHash: string;
  additions: readonly string[];
  updates: readonly string[];
  removals: readonly string[];
}>;

type CorpusExportManifest = Readonly<{
  schemaVersion: typeof CORPUS_EXPORT_SCHEMA_VERSION;
  kind: "corpusExportManifest";
  noncanonical: true;
  warning: string;
  exportId: string;
  repositoryId: string;
  repositoryGeneration: string | null;
  resolvedManifestHash: string;
  catalogHash: string;
  changesHash: string;
  changeRecordsHash: string;
  from: ChangeManifest["from"];
  artifacts: readonly Readonly<{ path: ArtifactName; contentHash: string; byteSize: number }>[];
}>;

type LatestPointer = Readonly<{
  schemaVersion: typeof CORPUS_EXPORT_SCHEMA_VERSION;
  kind: "corpusExportLatest";
  noncanonical: true;
  exportId: string;
  catalogHash: string;
  repositoryGeneration: string | null;
  resolvedManifestHash: string;
  path: string;
}>;

export type CorpusExportResult = Readonly<{
  exportId: string;
  path: string;
  catalogHash: string;
  reused: boolean;
  changes: Readonly<{ additions: number; updates: number; removals: number }>;
}>;

export async function generateCorpusExport(input: Readonly<{
  dataRoot?: string;
  fromExportId?: string;
  publishLatest?: boolean;
  beforeLatestPublication?: () => void | Promise<void>;
}> = {}): Promise<CorpusExportResult> {
  const root = await realpath(input.dataRoot ?? getDataRoot());
  const resolved = await loadResolvedCanonicalRevisions(root);
  const exportsRoot = resolve(root, "exports");
  await ensureExportsDirectory(root, exportsRoot);

  const catalog = await buildCatalog(root, resolved.manifest, resolved.generation, resolved.revisions);
  const catalogBytes = jsonFile(catalog);
  const catalogHash = hash(catalogBytes);
  const initialLatest = await loadLatestPublication(exportsRoot);
  const previous = await resolvePreviousExport(exportsRoot, input.fromExportId);
  if (previous?.manifest.catalogHash === catalogHash) {
    if (input.publishLatest !== false) {
      await input.beforeLatestPublication?.();
      await publishLatest(root, exportsRoot, previous.manifest, initialLatest?.pointer ?? null);
    }
    return result(previous.manifest.exportId, previous.path, catalogHash, true, previous.changes);
  }

  const changes = buildChanges(catalog, catalogHash, previous);
  const records = resolved.revisions
    .slice()
    .sort((left, right) => compare(left.entryId, right.entryId))
    .map((revision) => entryRecord(revision, catalog));
  const changedRecords = changeRecords(changes, records, previous);
  const changesBytes = jsonFile(changes);
  const changeRecordsBytes = jsonLines(changedRecords);
  const changesHash = hash(changesBytes);
  const changeRecordsHash = hash(changeRecordsBytes);
  const exportId = corpusExportId(catalogHash, changesHash, changeRecordsHash);
  const finalPath = resolve(exportsRoot, exportId);
  const existing = await loadExportIfPresent(finalPath);
  if (existing) {
    if (input.publishLatest !== false) {
      await input.beforeLatestPublication?.();
      await publishLatest(root, exportsRoot, existing.manifest, initialLatest?.pointer ?? null);
    }
    return result(exportId, finalPath, catalogHash, true, existing.changes);
  }

  const stagingPath = resolve(exportsRoot, `.${exportId}.${randomUUID()}.tmp`);
  await mkdir(stagingPath, { mode: 0o750 });
  try {
    const sources = buildSources(resolved.revisions, resolved.sourceFiles);
    const artifacts: Record<ArtifactName, string> = {
      "README.md": readme(catalog, catalogHash),
      "catalog.json": catalogBytes,
      "changes.json": changesBytes,
      "changes.jsonl": changeRecordsBytes,
      "entries.jsonl": jsonLines(records),
      "entries.md": markdown(catalog, resolved.revisions),
      "sources.json": jsonFile({
        schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
        kind: "corpusSources",
        noncanonical: true,
        sources,
      }),
    };
    for (const name of ARTIFACT_NAMES) await durableWrite(resolve(stagingPath, name), artifacts[name]);
    const manifest: CorpusExportManifest = {
      schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
      kind: "corpusExportManifest",
      noncanonical: true,
      warning: "Derived export. Canonical revisions and source files under DND_DATA_ROOT remain authoritative.",
      exportId,
      repositoryId: catalog.repositoryId,
      repositoryGeneration: catalog.repositoryGeneration,
      resolvedManifestHash: catalog.resolvedManifestHash,
      catalogHash,
      changesHash,
      changeRecordsHash,
      from: changes.from,
      artifacts: ARTIFACT_NAMES.map((path) => ({
        path,
        contentHash: hash(artifacts[path]),
        byteSize: Buffer.byteLength(artifacts[path]),
      })),
    };
    await durableWrite(resolve(stagingPath, "manifest.json"), jsonFile(manifest));
    await syncDirectory(stagingPath);
    await validateCorpusExport(stagingPath);
    try {
      await rename(stagingPath, finalPath);
    } catch (error) {
      if (!hasCode(error, "EEXIST") && !hasCode(error, "ENOTEMPTY")) throw error;
      await validateCorpusExport(finalPath);
    }
    await syncDirectory(exportsRoot);
  } finally {
    await rm(stagingPath, { recursive: true, force: true });
  }

  if (input.publishLatest !== false) {
    await input.beforeLatestPublication?.();
    const validated = await validateCorpusExport(finalPath);
    await publishLatest(root, exportsRoot, validated.manifest, initialLatest?.pointer ?? null);
  }
  return result(exportId, finalPath, catalogHash, false, changes);
}

export async function validateCorpusExport(exportDirectory: string): Promise<Readonly<{
  manifest: CorpusExportManifest;
  catalog: CorpusCatalog;
  changes: ChangeManifest;
}>> {
  const lexicalPath = resolve(exportDirectory);
  const lexicalExportsRoot = dirname(lexicalPath);
  if (basename(lexicalExportsRoot) !== "exports") throw new ContentIntegrityError("Corpus exports must be direct children of an exports directory.");
  const exportsRoot = await assertNoFollowDirectory(lexicalExportsRoot, "Corpus exports root");
  if (resolve(lexicalExportsRoot) !== exportsRoot) throw new ContentIntegrityError("Corpus exports root must not traverse symbolic links.");
  return validateCorpusExportInternal(lexicalPath, exportsRoot, new Set());
}

async function validateCorpusExportInternal(
  exportDirectory: string,
  exportsRoot: string,
  visited: Set<string>,
): ReturnType<typeof validateCorpusExport> {
  const path = await assertContainedExportDirectory(exportsRoot, exportDirectory);
  if (visited.has(path)) throw new ContentIntegrityError("Corpus export predecessor chain contains a cycle.");
  const nextVisited = new Set(visited).add(path);
  const names = (await readdir(path)).sort(compare);
  const expectedNames = [...ARTIFACT_NAMES, "manifest.json"].sort(compare);
  if (!sameStrings(names, expectedNames)) throw new ContentIntegrityError("Corpus export contains missing or unexpected artifacts.");

  const artifactBytes = new Map<string, Buffer>();
  for (const name of expectedNames) artifactBytes.set(name, await readContainedArtifact(exportsRoot, path, name));
  const manifest = parseManifest(artifactBytes.get("manifest.json")!.toString("utf8"));
  if (basename(path) !== manifest.exportId && !basename(path).endsWith(".tmp")) {
    throw new ContentIntegrityError("Corpus export directory does not match exportId.");
  }
  for (const artifact of manifest.artifacts) {
    const bytes = artifactBytes.get(artifact.path)!;
    if (bytes.byteLength !== artifact.byteSize || hash(bytes) !== artifact.contentHash) {
      throw new ContentIntegrityError(`Corpus export artifact failed hash validation: ${artifact.path}`);
    }
  }

  const catalogText = artifactBytes.get("catalog.json")!.toString("utf8");
  const catalog = parseCatalog(catalogText);
  if (hash(catalogText) !== manifest.catalogHash) throw new ContentIntegrityError("Corpus catalog hash does not match the export manifest.");
  if (
    catalog.repositoryId !== manifest.repositoryId
    || catalog.repositoryGeneration !== manifest.repositoryGeneration
    || catalog.resolvedManifestHash !== manifest.resolvedManifestHash
  ) throw new ContentIntegrityError("Corpus catalog provenance does not match the export manifest.");

  const changesText = artifactBytes.get("changes.json")!.toString("utf8");
  const changeRecordsText = artifactBytes.get("changes.jsonl")!.toString("utf8");
  const changes = parseChanges(changesText);
  if (hash(changesText) !== manifest.changesHash || hash(changeRecordsText) !== manifest.changeRecordsHash) {
    throw new ContentIntegrityError("Corpus change hashes do not match the export manifest.");
  }
  if (canonicalJson((changes.from ?? null) as JsonValue) !== canonicalJson((manifest.from ?? null) as JsonValue)) {
    throw new ContentIntegrityError("Corpus change boundary does not match the export manifest.");
  }
  if (changes.toCatalogHash !== manifest.catalogHash) throw new ContentIntegrityError("Corpus change target does not match the catalog.");
  if (corpusExportId(manifest.catalogHash, manifest.changesHash, manifest.changeRecordsHash) !== manifest.exportId) {
    throw new ContentIntegrityError("Corpus exportId is not derived from its catalog and complete change artifacts.");
  }

  let previous: Awaited<ReturnType<typeof resolvePreviousExport>> = null;
  if (changes.from) {
    if (changes.from.exportId === manifest.exportId) throw new ContentIntegrityError("Corpus export cannot declare itself as its predecessor.");
    const predecessorPath = resolve(exportsRoot, changes.from.exportId);
    const validated = await validateCorpusExportInternal(predecessorPath, exportsRoot, nextVisited);
    if (validated.manifest.catalogHash !== changes.from.catalogHash) {
      throw new ContentIntegrityError("Corpus predecessor catalog hash does not match the declared comparison boundary.");
    }
    previous = { path: predecessorPath, ...validated };
  }
  const expectedChanges = buildChanges(catalog, manifest.catalogHash, previous);
  if (canonicalJson(changes as unknown as JsonValue) !== canonicalJson(expectedChanges as unknown as JsonValue)) {
    throw new ContentIntegrityError("Corpus change manifest does not match the actual predecessor catalog diff.");
  }

  const entryRecords = parseJsonLines(artifactBytes.get("entries.jsonl")!.toString("utf8"), "entries.jsonl");
  validateEntryRecords(entryRecords, catalog);
  const sourceDocument = parseCanonicalObject(artifactBytes.get("sources.json")!.toString("utf8"), "sources.json");
  validateSources(sourceDocument, catalog, entryRecords);
  const changeRecords = parseJsonLines(changeRecordsText, "changes.jsonl");
  validateChangeRecords(changeRecords, changes, entryRecords, previous);
  const revisions = entryRecords.map((record) => requireObject(record, "entry record").canonicalRevision as CanonicalRevision);
  if (artifactBytes.get("entries.md")!.toString("utf8") !== markdown(catalog, revisions)) {
    throw new ContentIntegrityError("entries.md is not the deterministic complete rendering of entries.jsonl.");
  }
  if (artifactBytes.get("README.md")!.toString("utf8") !== readme(catalog, manifest.catalogHash)) {
    throw new ContentIntegrityError("README.md does not match the export catalog.");
  }
  return { manifest, catalog, changes };
}

export async function validatePublishedCorpusExport(dataRoot: string, exportId?: string): ReturnType<typeof validateCorpusExport> {
  const root = await realpath(dataRoot);
  const exportsRoot = resolve(root, "exports");
  if (exportId) {
    assertExportId(exportId);
    return validateCorpusExport(resolve(exportsRoot, exportId));
  }
  const latest = await loadLatestPublication(exportsRoot);
  if (!latest) throw new ContentIntegrityError("No latest corpus export has been published.");
  return latest.validated;
}

async function buildCatalog(
  root: string,
  manifest: RepositoryManifest,
  generation: string | null,
  revisions: readonly CanonicalRevision[],
): Promise<CorpusCatalog> {
  const schemas: SchemaDeclaration[] = [];
  for (const declaration of manifest.schemas.slice().sort((left, right) => compare(left.schemaId, right.schemaId))) {
    const bytes = await readFile(resolveWithin(root, declaration.path));
    const document = parseObject(bytes.toString("utf8"), declaration.path);
    schemas.push({
      schemaId: declaration.schemaId,
      schemaVersion: schemaVersion(document, declaration.path),
      path: declaration.path,
      contentHash: hash(bytes),
    });
  }
  const sources = new Map<string, Set<string>>();
  for (const revision of revisions) {
    const fileIds = sources.get(revision.source.sourceId) ?? new Set<string>();
    for (const file of revision.source.files) fileIds.add(file.fileId);
    sources.set(revision.source.sourceId, fileIds);
  }
  return {
    schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
    kind: "corpusCatalog",
    noncanonical: true,
    repositoryId: manifest.repositoryId,
    repositoryGeneration: generation,
    resolvedManifestHash: hash(canonicalJson(manifest as unknown as JsonValue)),
    schemas,
    entries: revisions.map(({ entryId, revisionId, contentHash }) => ({ entryId, revisionId, contentHash }))
      .sort((left, right) => compare(left.entryId, right.entryId)),
    sources: [...sources].sort(([left], [right]) => compare(left, right)).map(([sourceId, fileIds]) => ({
      sourceId,
      fileIds: [...fileIds].sort(compare),
    })),
  };
}

function buildSources(revisions: readonly CanonicalRevision[], files: readonly ValidatedSourceFile[]): readonly SourceExport[] {
  const sources = new Map<string, ContentSource>();
  for (const revision of revisions) sources.set(revision.source.sourceId, revision.source);
  return [...sources.values()].sort((left, right) => compare(left.sourceId, right.sourceId)).map((source) => ({
    source,
    files: files.filter((file) => file.sourceId === source.sourceId).sort((left, right) => compare(left.fileId, right.fileId)),
  }));
}

function buildChanges(
  catalog: CorpusCatalog,
  catalogHash: string,
  previous: Awaited<ReturnType<typeof resolvePreviousExport>>,
): ChangeManifest {
  const before = new Map(previous?.catalog.entries.map((entry) => [entry.entryId, entry]) ?? []);
  const after = new Map(catalog.entries.map((entry) => [entry.entryId, entry]));
  const additions = catalog.entries.filter((entry) => !before.has(entry.entryId)).map((entry) => entry.entryId);
  const updates = catalog.entries.filter((entry) => {
    const prior = before.get(entry.entryId);
    return prior && (prior.revisionId !== entry.revisionId || prior.contentHash !== entry.contentHash);
  }).map((entry) => entry.entryId);
  const removals = [...before.keys()].filter((entryId) => !after.has(entryId)).sort(compare);
  return {
    schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
    kind: "corpusChangedEntryManifest",
    noncanonical: true,
    from: previous ? { exportId: previous.manifest.exportId, catalogHash: previous.manifest.catalogHash } : null,
    toCatalogHash: catalogHash,
    additions,
    updates,
    removals,
  };
}

function entryRecord(revision: CanonicalRevision, catalog: CorpusCatalog): JsonValue {
  return {
    schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
    kind: "corpusEntry",
    noncanonical: true,
    repositoryId: catalog.repositoryId,
    canonicalSchemaVersion: revision.schemaVersion,
    entryId: revision.entryId,
    revisionId: revision.revisionId,
    contentHash: revision.contentHash,
    canonicalRevision: revision as unknown as JsonValue,
  };
}

function changeRecords(changes: ChangeManifest, records: readonly JsonValue[], previous: Awaited<ReturnType<typeof resolvePreviousExport>>): readonly JsonValue[] {
  const byId = new Map(records.map((record) => [(record as { entryId: string }).entryId, record]));
  return ([
    ...changes.additions.map((entryId) => ({ change: "addition", entry: byId.get(entryId)! } as JsonValue)),
    ...changes.updates.map((entryId) => {
      const prior = previous!.catalog.entries.find((entry) => entry.entryId === entryId)!;
      return {
        change: "update",
        entry: byId.get(entryId)!,
        previousRevisionId: prior.revisionId,
        previousContentHash: prior.contentHash,
      } as JsonValue;
    }),
    ...changes.removals.map((entryId) => {
      const prior = previous!.catalog.entries.find((entry) => entry.entryId === entryId)!;
      return { change: "removal", entryId, previousRevisionId: prior.revisionId, previousContentHash: prior.contentHash } as JsonValue;
    }),
  ] as Array<JsonValue>).sort((left, right) => compare(changeRecordEntryId(left), changeRecordEntryId(right)));
}

function markdown(catalog: CorpusCatalog, revisions: readonly CanonicalRevision[]): string {
  const lines = [
    "# Portable Compendium Corpus",
    "",
    "> NONCANONICAL DERIVED EXPORT: canonical revisions and source files under DND_DATA_ROOT are authoritative.",
    "",
    `- Repository: \`${catalog.repositoryId}\``,
    `- Resolved generation: \`${catalog.repositoryGeneration ?? "bootstrap"}\``,
    `- Resolved manifest hash: \`${catalog.resolvedManifestHash}\``,
    `- Export schema version: \`${CORPUS_EXPORT_SCHEMA_VERSION}\``,
    "",
  ];
  for (const revision of revisions.slice().sort((left, right) => compare(left.entryId, right.entryId))) {
    const name = typeof revision.entry.name === "string" ? revision.entry.name : revision.entryId;
    lines.push(
      `## ${markdownText(name)} (\`${revision.entryId}\`)`,
      "",
      `Canonical revision: \`${revision.revisionId}\`  `,
      `Canonical content hash: \`${revision.contentHash}\`  `,
      `Source: ${markdownText(revision.source.title)} (\`${revision.source.sourceId}\`)`,
      "",
      "```json",
      prettyCanonicalJson(revision as unknown as JsonValue),
      "```",
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function readme(catalog: CorpusCatalog, catalogHash: string): string {
  return `# Derived corpus export\n\nThis directory is a reproducible, noncanonical view of canonical resolved NFS revisions. Do not edit or treat it as authoritative.\n\n- Repository: \`${catalog.repositoryId}\`\n- Resolved generation: \`${catalog.repositoryGeneration ?? "bootstrap"}\`\n- Catalog hash: \`${catalogHash}\`\n- Full machine corpus: \`entries.jsonl\` (one complete entry per line)\n- Full readable corpus: \`entries.md\`\n- Source provenance: \`sources.json\`\n- Incremental boundary and IDs: \`changes.json\`\n- Incremental records and removal tombstones: \`changes.jsonl\`\n- Artifact integrity: \`manifest.json\`\n`;
}

async function resolvePreviousExport(exportsRoot: string, requested?: string) {
  if (requested) {
    assertExportId(requested);
    const path = resolve(exportsRoot, requested);
    const validated = await validateCorpusExport(path);
    return { path, ...validated };
  }
  const latest = await loadLatestPublication(exportsRoot);
  return latest ? { path: latest.path, ...latest.validated } : null;
}

async function loadExportIfPresent(path: string) {
  try {
    return await validateCorpusExport(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function loadLatestPublication(exportsRoot: string): Promise<Readonly<{
  pointer: LatestPointer;
  path: string;
  validated: Awaited<ReturnType<typeof validateCorpusExport>>;
}> | null> {
  const latestPath = resolve(exportsRoot, "latest.json");
  let pointerText: string;
  try {
    pointerText = (await readNoFollowFile(exportsRoot, latestPath, "latest.json")).toString("utf8");
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
  const pointer = parseLatest(pointerText);
  const path = resolve(exportsRoot, pointer.exportId);
  const validated = await validateCorpusExport(path);
  assertLatestMatches(pointer, validated.manifest);
  return { pointer, path, validated };
}

async function publishLatest(
  root: string,
  exportsRoot: string,
  manifest: CorpusExportManifest,
  expected: LatestPointer | null,
): Promise<void> {
  const lockPath = resolve(exportsRoot, ".latest.lock");
  try {
    await mkdir(lockPath, { mode: 0o750 });
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new ContentIntegrityError("Another corpus latest publication currently owns the filesystem fence.");
    throw error;
  }
  try {
    const actual = await loadLatestPublication(exportsRoot);
    if (canonicalJson((actual?.pointer ?? null) as unknown as JsonValue) !== canonicalJson((expected ?? null) as unknown as JsonValue)) {
      throw new ContentIntegrityError("Corpus latest publication lost its compare-and-swap boundary.");
    }
    if (actual && compareCanonicalGeneration(manifest.repositoryGeneration, actual.pointer.repositoryGeneration) < 0) {
      throw new ContentIntegrityError("Corpus latest publication cannot regress canonical snapshot generation.");
    }
    const candidate = await validateCorpusExport(resolve(exportsRoot, manifest.exportId));
    if (canonicalJson(candidate.manifest as unknown as JsonValue) !== canonicalJson(manifest as unknown as JsonValue)) {
      throw new ContentIntegrityError("Corpus latest candidate changed after generation validation.");
    }

    // Re-resolve under the publication fence so a paused generator cannot expose
    // a snapshot that ceased to be canonical before pointer replacement.
    const resolved = await loadResolvedCanonicalRevisions(root);
    const currentCatalog = await buildCatalog(root, resolved.manifest, resolved.generation, resolved.revisions);
    const currentCatalogHash = hash(jsonFile(currentCatalog));
    if (
      currentCatalogHash !== manifest.catalogHash
      || currentCatalog.repositoryGeneration !== manifest.repositoryGeneration
      || currentCatalog.resolvedManifestHash !== manifest.resolvedManifestHash
    ) throw new ContentIntegrityError("Canonical repository advanced before corpus latest publication.");

    const pointer: LatestPointer = {
      schemaVersion: CORPUS_EXPORT_SCHEMA_VERSION,
      kind: "corpusExportLatest",
      noncanonical: true,
      exportId: manifest.exportId,
      catalogHash: manifest.catalogHash,
      repositoryGeneration: manifest.repositoryGeneration,
      resolvedManifestHash: manifest.resolvedManifestHash,
      path: `${manifest.exportId}/manifest.json`,
    };
    const temporary = resolve(exportsRoot, `.latest.${randomUUID()}.tmp`);
    try {
      await durableWrite(temporary, jsonFile(pointer));
      // The pointer and canonical snapshot were checked while this exclusive
      // fence was held; rename is the only visibility transition.
      await rename(temporary, resolve(exportsRoot, "latest.json"));
      await syncDirectory(exportsRoot);
    } finally {
      await rm(temporary, { force: true });
    }
  } finally {
    await rm(lockPath, { recursive: true, force: true });
    await syncDirectory(exportsRoot);
  }
}

function assertLatestMatches(pointer: LatestPointer, manifest: CorpusExportManifest): void {
  if (
    manifest.exportId !== pointer.exportId || manifest.catalogHash !== pointer.catalogHash
    || manifest.repositoryGeneration !== pointer.repositoryGeneration
    || manifest.resolvedManifestHash !== pointer.resolvedManifestHash
    || pointer.path !== `${pointer.exportId}/manifest.json`
  ) throw new ContentIntegrityError("Latest corpus pointer does not match its export.");
}

function compareCanonicalGeneration(left: string | null, right: string | null): number {
  if (left === right) return 0;
  if (left === null) return -1;
  if (right === null) return 1;
  return compare(left, right);
}

function validateEntryRecords(records: readonly unknown[], catalog: CorpusCatalog): void {
  if (records.length !== catalog.entries.length) throw new ContentIntegrityError("entries.jsonl count does not match catalog.json.");
  for (let index = 0; index < records.length; index++) {
    const record = requireObject(records[index], `entries.jsonl line ${index + 1}`);
    assertExactKeys(record, ["canonicalRevision", "canonicalSchemaVersion", "contentHash", "entryId", "kind", "noncanonical", "repositoryId", "revisionId", "schemaVersion"], `entries.jsonl line ${index + 1}`);
    if (record.schemaVersion !== CORPUS_EXPORT_SCHEMA_VERSION || record.kind !== "corpusEntry" || record.noncanonical !== true) {
      throw new ContentIntegrityError(`entries.jsonl line ${index + 1} has an unsupported export schema.`);
    }
    assertCanonicalRevision(record.canonicalRevision);
    const revision = record.canonicalRevision;
    const expected = catalog.entries[index];
    if (
      record.repositoryId !== catalog.repositoryId || record.canonicalSchemaVersion !== revision.schemaVersion
      || record.entryId !== expected.entryId || record.revisionId !== expected.revisionId || record.contentHash !== expected.contentHash
      || revision.entryId !== expected.entryId || revision.revisionId !== expected.revisionId || revision.contentHash !== expected.contentHash
    ) throw new ContentIntegrityError(`entries.jsonl line ${index + 1} does not match catalog.json.`);
  }
}

function validateSources(document: Record<string, unknown>, catalog: CorpusCatalog, records: readonly unknown[]): void {
  assertExactKeys(document, ["kind", "noncanonical", "schemaVersion", "sources"], "sources.json");
  if (document.schemaVersion !== CORPUS_EXPORT_SCHEMA_VERSION || document.kind !== "corpusSources" || document.noncanonical !== true || !Array.isArray(document.sources)) {
    throw new ContentIntegrityError("sources.json has an unsupported export schema.");
  }
  const expectedSources = new Map<string, ContentSource>();
  for (const value of records) {
    const revision = requireObject(requireObject(value, "entry record").canonicalRevision, "canonical revision") as unknown as CanonicalRevision;
    expectedSources.set(revision.source.sourceId, revision.source);
  }
  if (document.sources.length !== catalog.sources.length) throw new ContentIntegrityError("sources.json count does not match catalog.json.");
  const observedSourceIds: string[] = [];
  for (let index = 0; index < document.sources.length; index++) {
    const exported = requireObject(document.sources[index], `sources.json source ${index + 1}`);
    assertExactKeys(exported, ["files", "source"], `sources.json source ${index + 1}`);
    const source = requireObject(exported.source, `sources.json source ${index + 1} provenance`) as unknown as ContentSource;
    observedSourceIds.push(source.sourceId);
    const expected = expectedSources.get(source.sourceId);
    if (!expected || canonicalJson(source as unknown as JsonValue) !== canonicalJson(expected as unknown as JsonValue)) {
      throw new ContentIntegrityError(`sources.json source ${source.sourceId} does not match entry provenance.`);
    }
    if (!Array.isArray(exported.files) || exported.files.length !== source.files.length) {
      throw new ContentIntegrityError(`sources.json source ${source.sourceId} has incomplete file metadata.`);
    }
    const expectedCatalog = catalog.sources[index];
    if (expectedCatalog?.sourceId !== source.sourceId || !sameStrings(expectedCatalog.fileIds, source.files.map((file) => file.fileId).sort(compare))) {
      throw new ContentIntegrityError(`sources.json source ${source.sourceId} does not match catalog.json.`);
    }
    const canonicalFiles = new Map(source.files.map((file) => [file.fileId, file]));
    const observedFileIds: string[] = [];
    for (let fileIndex = 0; fileIndex < exported.files.length; fileIndex++) {
      const file = requireObject(exported.files[fileIndex], `sources.json file ${fileIndex + 1}`);
      assertExactKeys(file, ["byteSize", "contentHash", "fileId", "mediaType", "path", "sourceId"], `sources.json file ${fileIndex + 1}`);
      const canonical = canonicalFiles.get(String(file.fileId));
      observedFileIds.push(String(file.fileId));
      if (
        !canonical || file.sourceId !== source.sourceId || file.fileId !== canonical.fileId || file.path !== canonical.path
        || file.mediaType !== canonical.mediaType || file.contentHash !== canonical.contentHash
        || !Number.isSafeInteger(file.byteSize) || Number(file.byteSize) < 0
      ) throw new ContentIntegrityError(`sources.json file ${String(file.fileId)} has invalid provenance.`);
    }
    if (!isSortedUnique(observedFileIds)) throw new ContentIntegrityError(`sources.json files for ${source.sourceId} are not byte-ordered.`);
  }
  if (!isSortedUnique(observedSourceIds)) throw new ContentIntegrityError("sources.json is not byte-ordered by sourceId.");
}

function validateChangeRecords(
  records: readonly unknown[],
  changes: ChangeManifest,
  entries: readonly unknown[],
  previous: Awaited<ReturnType<typeof resolvePreviousExport>>,
): void {
  const expectedCount = changes.additions.length + changes.updates.length + changes.removals.length;
  if (records.length !== expectedCount) throw new ContentIntegrityError("changes.jsonl count does not match changes.json.");
  const currentIds = new Set(entries.map((entry) => requireObject(entry, "entry record").entryId));
  const observed = { addition: [] as string[], update: [] as string[], removal: [] as string[] };
  const orderedIds: string[] = [];
  for (const value of records) {
    const record = requireObject(value, "changes.jsonl record");
    if (record.change === "removal") {
      assertExactKeys(record, ["change", "entryId", "previousContentHash", "previousRevisionId"], "changes.jsonl removal");
      const prior = previous?.catalog.entries.find((entry) => entry.entryId === record.entryId);
      if (
        typeof record.entryId !== "string" || currentIds.has(record.entryId)
        || typeof record.previousRevisionId !== "string" || !/^rev-[0-9a-f]{64}$/.test(record.previousRevisionId)
        || !HASH.test(String(record.previousContentHash))
        || !prior || prior.revisionId !== record.previousRevisionId || prior.contentHash !== record.previousContentHash
      ) {
        throw new ContentIntegrityError("changes.jsonl contains an invalid removal tombstone.");
      }
      observed.removal.push(record.entryId);
      orderedIds.push(record.entryId);
    } else if (record.change === "addition" || record.change === "update") {
      assertExactKeys(
        record,
        record.change === "update" ? ["change", "entry", "previousContentHash", "previousRevisionId"] : ["change", "entry"],
        `changes.jsonl ${record.change}`,
      );
      const entry = requireObject(record.entry, "changed entry");
      if (typeof entry.entryId !== "string" || !currentIds.has(entry.entryId)) throw new ContentIntegrityError("changes.jsonl contains an invalid changed entry.");
      const full = entries.find((candidate) => requireObject(candidate, "entry record").entryId === entry.entryId);
      if (canonicalJson(entry as JsonValue) !== canonicalJson(full as JsonValue)) {
        throw new ContentIntegrityError("changes.jsonl changed entry does not match entries.jsonl.");
      }
      const prior = previous?.catalog.entries.find((candidate) => candidate.entryId === entry.entryId);
      if (
        record.change === "addition" && prior
        || record.change === "update" && (
          !prior || record.previousRevisionId !== prior.revisionId || record.previousContentHash !== prior.contentHash
        )
      ) throw new ContentIntegrityError("changes.jsonl previous identity does not match the predecessor catalog.");
      observed[record.change].push(entry.entryId);
      orderedIds.push(entry.entryId);
    } else throw new ContentIntegrityError("changes.jsonl contains an unknown change kind.");
  }
  if (!sameStrings(observed.addition, changes.additions) || !sameStrings(observed.update, changes.updates) || !sameStrings(observed.removal, changes.removals)) {
    throw new ContentIntegrityError("changes.jsonl IDs do not match changes.json.");
  }
  if (!isSortedUnique(orderedIds)) throw new ContentIntegrityError("changes.jsonl is not byte-ordered by entryId.");
}

function parseManifest(text: string): CorpusExportManifest {
  const value = parseCanonicalObject(text, "manifest.json");
  assertExactKeys(value, ["artifacts", "catalogHash", "changeRecordsHash", "changesHash", "exportId", "from", "kind", "noncanonical", "repositoryGeneration", "repositoryId", "resolvedManifestHash", "schemaVersion", "warning"], "manifest.json");
  assertCommon(value, "corpusExportManifest");
  assertExportId(value.exportId);
  if (
    value.warning !== "Derived export. Canonical revisions and source files under DND_DATA_ROOT remain authoritative."
    || typeof value.repositoryId !== "string" || !isGeneration(value.repositoryGeneration)
    || !HASH.test(String(value.catalogHash)) || !HASH.test(String(value.resolvedManifestHash))
    || !HASH.test(String(value.changesHash)) || !HASH.test(String(value.changeRecordsHash)) || !Array.isArray(value.artifacts)
  ) {
    throw new ContentIntegrityError("manifest.json has invalid hashes or artifacts.");
  }
  const artifacts = value.artifacts.map((item) => requireObject(item, "manifest artifact"));
  for (const artifact of artifacts) assertExactKeys(artifact, ["byteSize", "contentHash", "path"], "manifest artifact");
  const paths = artifacts.map((item) => item.path);
  if (!sameStrings(paths, ARTIFACT_NAMES)) throw new ContentIntegrityError("manifest.json artifact list is incomplete or unordered.");
  if (artifacts.some((artifact) => !HASH.test(String(artifact.contentHash)) || !Number.isSafeInteger(artifact.byteSize) || Number(artifact.byteSize) < 0)) {
    throw new ContentIntegrityError("manifest.json contains invalid artifact integrity metadata.");
  }
  return value as unknown as CorpusExportManifest;
}

function parseCatalog(text: string): CorpusCatalog {
  const value = parseCanonicalObject(text, "catalog.json");
  assertExactKeys(value, ["entries", "kind", "noncanonical", "repositoryGeneration", "repositoryId", "resolvedManifestHash", "schemaVersion", "schemas", "sources"], "catalog.json");
  assertCommon(value, "corpusCatalog");
  if (
    typeof value.repositoryId !== "string" || !isGeneration(value.repositoryGeneration)
    || !Array.isArray(value.entries) || !Array.isArray(value.schemas) || !Array.isArray(value.sources) || !HASH.test(String(value.resolvedManifestHash))
  ) {
    throw new ContentIntegrityError("catalog.json has invalid collections or provenance.");
  }
  const entries = value.entries.map((item) => requireObject(item, "catalog entry"));
  for (const entry of entries) assertExactKeys(entry, ["contentHash", "entryId", "revisionId"], "catalog entry");
  const ids = entries.map((entry) => String(entry.entryId));
  if (!isSortedUnique(ids) || entries.some((entry) => typeof entry.entryId !== "string" || typeof entry.revisionId !== "string" || !/^rev-[0-9a-f]{64}$/.test(entry.revisionId) || !HASH.test(String(entry.contentHash)))) {
    throw new ContentIntegrityError("catalog.json entries are invalid or not byte-ordered.");
  }
  const schemas = value.schemas.map((item) => requireObject(item, "catalog schema"));
  for (const schema of schemas) assertExactKeys(schema, ["contentHash", "path", "schemaId", "schemaVersion"], "catalog schema");
  const schemaIds = schemas.map((schema) => String(schema.schemaId));
  if (!isSortedUnique(schemaIds) || schemas.some((schema) => typeof schema.schemaId !== "string" || !Number.isSafeInteger(schema.schemaVersion) || Number(schema.schemaVersion) < 1 || !HASH.test(String(schema.contentHash)) || typeof schema.path !== "string")) {
    throw new ContentIntegrityError("catalog.json schemas are invalid or not byte-ordered.");
  }
  const sources = value.sources.map((item) => requireObject(item, "catalog source"));
  for (const source of sources) assertExactKeys(source, ["fileIds", "sourceId"], "catalog source");
  const sourceIds = sources.map((source) => String(source.sourceId));
  if (!isSortedUnique(sourceIds) || sources.some((source) => typeof source.sourceId !== "string" || !Array.isArray(source.fileIds) || source.fileIds.some((fileId) => typeof fileId !== "string") || !isSortedUnique(source.fileIds as string[]))) {
    throw new ContentIntegrityError("catalog.json sources are invalid or not byte-ordered.");
  }
  return value as unknown as CorpusCatalog;
}

function parseChanges(text: string): ChangeManifest {
  const value = parseCanonicalObject(text, "changes.json");
  assertExactKeys(value, ["additions", "from", "kind", "noncanonical", "removals", "schemaVersion", "toCatalogHash", "updates"], "changes.json");
  assertCommon(value, "corpusChangedEntryManifest");
  for (const key of ["additions", "updates", "removals"] as const) {
    if (!Array.isArray(value[key]) || value[key].some((entryId) => typeof entryId !== "string") || !isSortedUnique(value[key] as string[])) throw new ContentIntegrityError(`changes.json ${key} are invalid or not byte-ordered.`);
  }
  const allIds = [...value.additions as string[], ...value.updates as string[], ...value.removals as string[]];
  if (new Set(allIds).size !== allIds.length) throw new ContentIntegrityError("changes.json change sets must be disjoint.");
  if (value.from !== null) {
    const from = requireObject(value.from, "changes.json from boundary");
    assertExactKeys(from, ["catalogHash", "exportId"], "changes.json from boundary");
    assertExportId(from.exportId);
    if (!HASH.test(String(from.catalogHash))) throw new ContentIntegrityError("changes.json from boundary is invalid.");
  }
  if (!HASH.test(String(value.toCatalogHash))) throw new ContentIntegrityError("changes.json target hash is invalid.");
  return value as unknown as ChangeManifest;
}

function parseLatest(text: string): LatestPointer {
  const value = parseCanonicalObject(text, "latest.json");
  assertExactKeys(value, ["catalogHash", "exportId", "kind", "noncanonical", "path", "repositoryGeneration", "resolvedManifestHash", "schemaVersion"], "latest.json");
  assertCommon(value, "corpusExportLatest");
  assertExportId(value.exportId);
  if (
    !HASH.test(String(value.catalogHash)) || !HASH.test(String(value.resolvedManifestHash))
    || !isGeneration(value.repositoryGeneration) || typeof value.path !== "string"
  ) throw new ContentIntegrityError("latest.json is invalid.");
  return value as unknown as LatestPointer;
}

function assertCommon(value: Record<string, unknown>, kind: string): void {
  if (value.schemaVersion !== CORPUS_EXPORT_SCHEMA_VERSION || value.kind !== kind || value.noncanonical !== true) {
    throw new ContentIntegrityError(`${kind} has an unsupported export schema.`);
  }
}

function parseJsonLines(text: string, name: string): readonly unknown[] {
  if (text === "") return [];
  if (!text.endsWith("\n")) throw new ContentIntegrityError(`${name} must end with a newline.`);
  return text.slice(0, -1).split("\n").map((line, index) => {
    try {
      const value: unknown = JSON.parse(line);
      if (line !== canonicalJson(value as JsonValue)) throw new ContentIntegrityError(`${name} line ${index + 1} is not canonical JSON.`);
      return value;
    } catch (error) {
      if (error instanceof ContentIntegrityError) throw error;
      throw new ContentIntegrityError(`${name} line ${index + 1} is not JSON.`);
    }
  });
}

function parseCanonicalObject(text: string, name: string): Record<string, unknown> {
  const value = parseObject(text, name);
  if (text !== jsonFile(value)) throw new ContentIntegrityError(`${name} is not canonical JSON with one trailing newline.`);
  return value;
}

function parseObject(text: string, name: string): Record<string, unknown> {
  try { return requireObject(JSON.parse(text), name); } catch (error) {
    if (error instanceof ContentIntegrityError) throw error;
    throw new ContentIntegrityError(`${name} is not valid JSON.`);
  }
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ContentIntegrityError(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], name: string): void {
  const actual = Object.keys(value).sort(compare);
  const expected = [...keys].sort(compare);
  if (!sameStrings(actual, expected)) throw new ContentIntegrityError(`${name} contains missing or unknown fields.`);
}

function schemaVersion(schema: Record<string, unknown>, path: string): number {
  const match = /\/v([1-9][0-9]*)\//.exec(path);
  if (!match || typeof schema.$id !== "string") throw new ContentIntegrityError(`Schema declaration has no portable version: ${path}`);
  return Number(match[1]);
}

function resolveWithin(root: string, repositoryPath: string): string {
  const path = resolve(root, repositoryPath);
  const fromRoot = relative(root, path);
  if (fromRoot.startsWith("..") || fromRoot === "" || basename(repositoryPath) === "") throw new ContentIntegrityError(`Export schema path escapes DND_DATA_ROOT: ${repositoryPath}`);
  return path;
}

async function assertNoFollowDirectory(path: string, name: string): Promise<string> {
  const lexicalPath = resolve(path);
  const metadata = await lstat(lexicalPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ContentIntegrityError(`${name} must be a no-follow directory.`);
  const physicalPath = await realpath(lexicalPath);
  if (physicalPath !== lexicalPath) throw new ContentIntegrityError(`${name} must be physically contained without symbolic-link ancestors.`);
  return physicalPath;
}

async function assertContainedExportDirectory(exportsRoot: string, exportDirectory: string): Promise<string> {
  const lexicalPath = resolve(exportDirectory);
  if (dirname(lexicalPath) !== exportsRoot || relative(exportsRoot, lexicalPath).includes(sep)) {
    throw new ContentIntegrityError("Corpus export directory must be directly contained under exports.");
  }
  const metadata = await lstat(lexicalPath);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new ContentIntegrityError("Corpus export path must be a no-follow directory.");
  const physicalPath = await realpath(lexicalPath);
  if (physicalPath !== lexicalPath || dirname(physicalPath) !== exportsRoot) {
    throw new ContentIntegrityError("Corpus export directory is not physically contained under exports.");
  }
  return physicalPath;
}

async function readContainedArtifact(exportsRoot: string, exportDirectory: string, name: string): Promise<Buffer> {
  if (basename(name) !== name) throw new ContentIntegrityError(`Corpus artifact name is not a direct filename: ${name}`);
  return readNoFollowFile(exportsRoot, resolve(exportDirectory, name), name, exportDirectory);
}

async function readNoFollowFile(exportsRoot: string, path: string, name: string, expectedParent = exportsRoot): Promise<Buffer> {
  const lexicalPath = resolve(path);
  if (dirname(lexicalPath) !== expectedParent || relative(exportsRoot, lexicalPath).startsWith(`..${sep}`)) {
    throw new ContentIntegrityError(`${name} is not physically contained under exports.`);
  }
  const metadata = await lstat(lexicalPath);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new ContentIntegrityError(`${name} must be a no-follow regular file.`);
  if (await realpath(lexicalPath) !== lexicalPath) throw new ContentIntegrityError(`${name} traverses a symbolic link.`);
  const handle = await open(lexicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new ContentIntegrityError(`${name} must remain a regular file while read.`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function ensureExportsDirectory(root: string, exportsRoot: string): Promise<void> {
  try {
    const metadata = await lstat(exportsRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ContentIntegrityError("exports must be a regular directory under DND_DATA_ROOT.");
    if (await realpath(exportsRoot) !== exportsRoot) throw new ContentIntegrityError("exports must not traverse symbolic-link ancestors.");
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
    try {
      await mkdir(exportsRoot, { mode: 0o750 });
      await syncDirectory(root);
    } catch (mkdirError) {
      if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
      const metadata = await lstat(exportsRoot);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new ContentIntegrityError("exports must be a regular directory under DND_DATA_ROOT.");
      if (await realpath(exportsRoot) !== exportsRoot) throw new ContentIntegrityError("exports must not traverse symbolic-link ancestors.");
    }
  }
}

async function durableWrite(path: string, contents: string): Promise<void> {
  const handle = await open(path, "wx", 0o640);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function jsonFile(value: unknown): string { return `${canonicalJson(value as JsonValue)}\n`; }
function jsonLines(values: readonly JsonValue[]): string { return values.length === 0 ? "" : `${values.map(canonicalJson).join("\n")}\n`; }
function prettyCanonicalJson(value: JsonValue): string { return JSON.stringify(JSON.parse(canonicalJson(value)), null, 2); }
function hash(value: string | Uint8Array): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }
function compare(left: string, right: string): number { return Buffer.compare(Buffer.from(left), Buffer.from(right)); }
function sameStrings(left: readonly unknown[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
function isSortedUnique(values: readonly string[]): boolean { return sameStrings(values, [...new Set(values)].sort(compare)); }
function isGeneration(value: unknown): value is string | null { return value === null || typeof value === "string" && /^[0-9]{32}$/.test(value); }
function markdownText(value: string): string {
  return value
    .replace(/\r?\n/g, " ")
    .replace(/[\\`*_{}[\]()#+.!|\-]/g, "\\$&")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
function corpusExportId(catalogHash: string, changesHash: string, changeRecordsHash: string): string {
  return `corpus-${hash(canonicalJson({ catalogHash, changeRecordsHash, changesHash } as JsonValue)).slice("sha256:".length)}`;
}
function changeRecordEntryId(value: JsonValue): string {
  const record = value as Readonly<{ entryId?: string; entry?: Readonly<{ entryId?: string }> }>;
  return record.entryId ?? record.entry?.entryId ?? "";
}
function assertExportId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !EXPORT_ID.test(value)) throw new ContentIntegrityError("Corpus export ID is invalid.");
}
function result(exportId: string, path: string, catalogHash: string, reused: boolean, changes: ChangeManifest): CorpusExportResult {
  return { exportId, path, catalogHash, reused, changes: { additions: changes.additions.length, updates: changes.updates.length, removals: changes.removals.length } };
}
function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
