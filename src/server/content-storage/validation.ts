import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import canonicalRevisionSchema from "../../../content-repository/schemas/v1/canonical-revision.schema.json" with { type: "json" };
import repositoryManifestSchema from "../../../content-repository/schemas/v1/repository-manifest.schema.json" with { type: "json" };
import sourceSchema from "../../../content-repository/schemas/v1/source.schema.json" with { type: "json" };
import {
  canonicalJson,
  activationDirectoryPath,
  hasValidRevisionIdentity,
  manifestPath,
  parseActivationToken,
  sourceMetadataPath,
  type CanonicalRevision,
  type ContentSource,
  type JsonValue,
  type RepositoryManifest,
  type RepositoryActivation,
} from "./repository.ts";

type Section = Readonly<{
  sectionId: string;
  heading: string;
  text: string;
  startOffset: number;
  endOffset: number;
}>;

type Citation = Readonly<{
  citationId: string;
  sourceId: string;
  fileId: string;
  quote: string;
  startOffset: number;
  endOffset: number;
}>;

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addSchema(sourceSchema);

const validateSource = ajv.getSchema(sourceSchema.$id) as ValidateFunction<ContentSource>;
const validateRevision = ajv.compile(canonicalRevisionSchema) as ValidateFunction<CanonicalRevision>;
const validateManifestDocument = ajv.compile(repositoryManifestSchema) as ValidateFunction<RepositoryManifest>;

export class ContentSchemaValidationError extends Error {
  readonly errors: readonly ErrorObject[];

  constructor(documentName: string, errors: readonly ErrorObject[]) {
    super(`${documentName} does not match a supported content schema: ${ajv.errorsText([...errors])}`);
    this.name = "ContentSchemaValidationError";
    this.errors = errors;
  }
}

export class ContentIntegrityError extends Error {
  constructor(message = "Canonical revision content does not match its revisionId and contentHash.") {
    super(message);
    this.name = "ContentIntegrityError";
  }
}

export function assertContentSource(document: unknown): asserts document is ContentSource {
  if (!validateSource(document)) {
    throw new ContentSchemaValidationError("Content source", validateSource.errors ?? []);
  }
  assertUnique(document.files.map((file) => file.fileId), "Source file IDs");
}

export function assertCanonicalRevision(document: unknown): asserts document is CanonicalRevision {
  if (!validateRevision(document)) {
    throw new ContentSchemaValidationError("Canonical revision", validateRevision.errors ?? []);
  }
  if (!hasValidRevisionIdentity(document)) throw new ContentIntegrityError();

  assertContentSource(document.source);
  const plain = document.text.plain as string;
  const sections = document.text.sections as unknown as readonly Section[];
  const citations = document.citations as unknown as readonly Citation[];
  const typedFields = document.entry.typedFields as readonly Readonly<{ key: string }>[];

  assertUnique(sections.map((section) => section.sectionId), "Section IDs");
  assertUnique(citations.map((citation) => citation.citationId), "Citation IDs");
  assertUnique(typedFields.map((field) => field.key), "Typed field keys");

  let coveredUntil = 0;
  for (const section of sections) {
    assertSpan(section.startOffset, section.endOffset, plain.length, `Section ${section.sectionId}`);
    if (section.startOffset !== coveredUntil) {
      throw new ContentIntegrityError(`Section ${section.sectionId} does not provide contiguous complete-text coverage.`);
    }
    if (plain.slice(section.startOffset, section.endOffset) !== section.text) {
      throw new ContentIntegrityError(`Section ${section.sectionId} text does not match text.plain.`);
    }
    coveredUntil = section.endOffset;
  }
  if (coveredUntil !== plain.length) throw new ContentIntegrityError("Sections do not cover all of text.plain.");

  const fileIds = new Set(document.source.files.map((file) => file.fileId));
  for (const citation of citations) {
    assertSpan(citation.startOffset, citation.endOffset, plain.length, `Citation ${citation.citationId}`);
    if (citation.sourceId !== document.source.sourceId) {
      throw new ContentIntegrityError(`Citation ${citation.citationId} references a different source.`);
    }
    if (!fileIds.has(citation.fileId)) {
      throw new ContentIntegrityError(`Citation ${citation.citationId} references an unknown source file.`);
    }
    if (plain.slice(citation.startOffset, citation.endOffset) !== citation.quote) {
      throw new ContentIntegrityError(`Citation ${citation.citationId} quote does not match text.plain.`);
    }
  }
}

export function assertRepositoryManifest(document: unknown): asserts document is RepositoryManifest {
  if (!validateManifestDocument(document)) {
    throw new ContentSchemaValidationError("Repository manifest", validateManifestDocument.errors ?? []);
  }
  assertUnique(document.schemas.map((schema) => schema.schemaId), "Manifest schema IDs");
  assertUnique(document.schemas.map((schema) => schema.path), "Manifest schema paths");
  assertUnique(document.entries.map((entry) => entry.entryId), "Manifest entry IDs");
}

export function assertRepositoryActivation(document: unknown): asserts document is RepositoryActivation {
  if (
    !isRecord(document) ||
    Object.keys(document).some((key) => !["schemaVersion", "kind", "fencingToken", "manifest"].includes(key)) ||
    document.schemaVersion !== 1 ||
    document.kind !== "repositoryActivation" ||
    typeof document.fencingToken !== "string" ||
    !/^[0-9]{20}$/.test(document.fencingToken)
  ) {
    throw new ContentIntegrityError("Repository activation does not match the supported activation contract.");
  }
  parseActivationToken(document.fencingToken);
  assertRepositoryManifest(document.manifest);
}

export async function validateContentRepository(dataRoot: string): Promise<void> {
  const root = await realpath(dataRoot);
  await loadActiveRepositoryManifest(root);
}

export async function loadActiveRepositoryManifest(dataRoot: string): Promise<Readonly<{
  manifest: RepositoryManifest;
  fencingToken: string | null;
}>> {
  const root = await realpath(dataRoot);
  const activationDirectory = activationDirectoryPath(root);
  let activationNames: string[] = [];
  try {
    activationNames = (await readdir(activationDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^[0-9]{20}\.json$/.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }

  for (const name of activationNames) {
    try {
      const file = await resolveRepositoryFile(root, relative(root, resolve(activationDirectory, name)));
      const activation = await readJson(file, `Repository activation ${name}`);
      assertRepositoryActivation(activation);
      if (`${activation.fencingToken}.json` !== name) {
        throw new ContentIntegrityError(`Repository activation token does not match filename ${name}.`);
      }
      await validateManifestContents(root, activation.manifest);
      return { manifest: activation.manifest, fencingToken: activation.fencingToken };
    } catch {
      // A corrupt or incomplete higher activation is ignored in favor of the next valid token.
    }
  }

  const manifestFile = await resolveRepositoryFile(root, relative(root, manifestPath(root)));
  const manifest = await readJson(manifestFile, "Repository manifest");
  assertRepositoryManifest(manifest);
  await validateManifestContents(root, manifest);
  return { manifest, fencingToken: null };
}

async function validateManifestContents(root: string, manifest: RepositoryManifest): Promise<void> {
  for (const declaration of manifest.schemas) {
    const file = await resolveRepositoryFile(root, declaration.path);
    const schema = await readJson(file, `Schema ${declaration.schemaId}`);
    if (!isRecord(schema) || schema.$id !== declaration.schemaId) {
      throw new ContentIntegrityError(`Schema declaration ${declaration.schemaId} does not match the referenced schema $id.`);
    }
    if (!ajv.validateSchema(schema)) {
      throw new ContentIntegrityError(`Schema ${declaration.schemaId} is not a valid JSON Schema: ${ajv.errorsText()}`);
    }
  }

  const sources = new Map<string, ContentSource>();
  for (const entry of manifest.entries) {
    const expectedPath = `compendium/${entry.entryId}/revisions/${entry.revisionId}.json`;
    if (entry.path !== expectedPath) {
      throw new ContentIntegrityError(`Manifest entry ${entry.entryId} does not use its deterministic canonical path.`);
    }

    const revision = await readJson(await resolveRepositoryFile(root, entry.path), `Revision ${entry.revisionId}`);
    assertCanonicalRevision(revision);
    if (
      revision.entryId !== entry.entryId ||
      revision.revisionId !== entry.revisionId ||
      revision.contentHash !== entry.contentHash
    ) {
      throw new ContentIntegrityError(`Manifest metadata does not match revision ${entry.revisionId}.`);
    }

    let source = sources.get(revision.source.sourceId);
    if (!source) {
      source = await loadSource(root, revision.source.sourceId);
      sources.set(source.sourceId, source);
    }
    if (canonicalJson(source as JsonValue) !== canonicalJson(revision.source as unknown as JsonValue)) {
      throw new ContentIntegrityError(`Revision ${entry.revisionId} source provenance does not match its source record.`);
    }
  }

  for (const source of sources.values()) {
    for (const file of source.files) {
      const expectedPrefix = `sources/${source.sourceId}/files/`;
      if (!file.path.startsWith(expectedPrefix)) {
        throw new ContentIntegrityError(`Source file ${file.fileId} does not use its deterministic source directory.`);
      }
      const bytes = await readFile(await resolveRepositoryFile(root, file.path));
      const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actualHash !== file.contentHash) {
        throw new ContentIntegrityError(`Source file ${file.fileId} does not match its contentHash.`);
      }
    }
  }
}

export async function validateCanonicalRevisionDependencies(
  dataRoot: string,
  revision: CanonicalRevision,
): Promise<void> {
  assertCanonicalRevision(revision);
  const root = await realpath(dataRoot);
  const source = await loadSource(root, revision.source.sourceId);
  if (canonicalJson(source as JsonValue) !== canonicalJson(revision.source as unknown as JsonValue)) {
    throw new ContentIntegrityError(`Revision ${revision.revisionId} source provenance does not match its source record.`);
  }

  for (const file of source.files) {
    const expectedPrefix = `sources/${source.sourceId}/files/`;
    if (!file.path.startsWith(expectedPrefix)) {
      throw new ContentIntegrityError(`Source file ${file.fileId} does not use its deterministic source directory.`);
    }
    const bytes = await readFile(await resolveRepositoryFile(root, file.path));
    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualHash !== file.contentHash) {
      throw new ContentIntegrityError(`Source file ${file.fileId} does not match its contentHash.`);
    }
  }
}

async function loadSource(root: string, sourceId: string): Promise<ContentSource> {
  const path = relative(root, sourceMetadataPath(root, sourceId));
  const source = await readJson(await resolveRepositoryFile(root, path), `Source ${sourceId}`);
  assertContentSource(source);
  if (source.sourceId !== sourceId) throw new ContentIntegrityError(`Source record path does not match sourceId ${sourceId}.`);
  return source;
}

async function resolveRepositoryFile(root: string, repositoryPath: string): Promise<string> {
  if (isAbsolute(repositoryPath)) throw new ContentIntegrityError("Repository paths must be relative to DND_DATA_ROOT.");
  const lexicalPath = resolve(root, repositoryPath);
  assertWithinRoot(root, lexicalPath, repositoryPath);
  const physicalPath = await realpath(lexicalPath);
  assertWithinRoot(root, physicalPath, repositoryPath);
  return physicalPath;
}

function assertWithinRoot(root: string, path: string, repositoryPath: string): void {
  const fromRoot = relative(root, path);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new ContentIntegrityError(`Repository path escapes DND_DATA_ROOT: ${repositoryPath}`);
  }
}

async function readJson(path: string, name: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ContentIntegrityError(`${name} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertSpan(start: number, end: number, textLength: number, name: string): void {
  if (start < 0 || start >= end || end > textLength) {
    throw new ContentIntegrityError(`${name} has invalid or out-of-bounds offsets.`);
  }
}

function assertUnique(values: readonly string[], name: string): void {
  if (new Set(values).size !== values.length) throw new ContentIntegrityError(`${name} must be unique.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
