import { createHash } from "node:crypto";
import { resolve } from "node:path";

export const CONTENT_SCHEMA_VERSION = 1 as const;

const STABLE_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const REVISION_ID = /^rev-[0-9a-f]{64}$/;

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export type ContentSource = Readonly<{
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  kind: "source";
  sourceId: string;
  title: string;
  category: "core_rules" | "official_supplement" | "homebrew";
  edition: "5e" | "5.5e";
  language: "en" | "ru";
  accessTier: "open" | "premium" | "personal";
  shared: boolean;
  ownerUserId: string | null;
  publication: Readonly<{
    code: string;
    title: string;
    publisher: string;
    releaseYear: number;
    revision?: string;
    origin?: Readonly<{
      url: string;
      id: string;
    }>;
    attribution?: string;
    sourcePriority: number;
    canonicalBookId: string;
  }>;
  license?: string;
  files: readonly Readonly<{
    fileId: string;
    path: string;
    mediaType: string;
    contentHash: string;
  }>[];
}>;

export type CanonicalRevision = Readonly<{
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  kind: "canonicalRevision";
  entryId: string;
  revisionId: string;
  contentHash: string;
  createdAt: string;
  source: ContentSource;
  entry: Readonly<Record<string, JsonValue>>;
  text: Readonly<Record<string, JsonValue>>;
  citations: readonly Readonly<Record<string, JsonValue>>[];
}>;

export type CanonicalRevisionInput = Omit<CanonicalRevision, "revisionId" | "contentHash">;

export function getDataRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const root = environment.DND_DATA_ROOT?.trim();
  if (!root) throw new Error("DND_DATA_ROOT must name the content repository root.");
  return resolve(root);
}

export function manifestPath(root: string): string {
  return resolve(root, "manifests", "repository.json");
}

export function schemaPath(root: string, schemaName: string, schemaVersion = CONTENT_SCHEMA_VERSION): string {
  assertStableId(schemaName, "schemaName");
  assertPositiveInteger(schemaVersion, "schemaVersion");
  return resolve(root, "schemas", `v${schemaVersion}`, `${schemaName}.schema.json`);
}

export function sourcePdfPath(root: string, sourceId: string, fileId: string): string {
  assertStableId(sourceId, "sourceId");
  assertStableId(fileId, "fileId");
  return resolve(root, "sources", sourceId, "files", `${fileId}.pdf`);
}

export function sourceMetadataPath(root: string, sourceId: string): string {
  assertStableId(sourceId, "sourceId");
  return resolve(root, "sources", sourceId, "source.json");
}

export function canonicalRevisionPath(root: string, entryId: string, revisionId: string): string {
  assertStableId(entryId, "entryId");
  assertRevisionId(revisionId);
  return resolve(root, "compendium", entryId, "revisions", `${revisionId}.json`);
}

export function generationPath(root: string, generationId: string): string {
  assertStableId(generationId, "generationId");
  return resolve(root, "generations", generationId);
}

export function snapshotPath(root: string, snapshotId: string): string {
  assertStableId(snapshotId, "snapshotId");
  return resolve(root, "snapshots", `${snapshotId}.json`);
}

export function exportPath(root: string, exportId: string): string {
  assertStableId(exportId, "exportId");
  return resolve(root, "exports", exportId);
}

export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON cannot contain non-finite numbers.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

  const object = value as Readonly<Record<string, JsonValue>>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

export function contentHash(value: JsonValue): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

export function revisionIdentity(input: CanonicalRevisionInput): Readonly<{ revisionId: string; contentHash: string }> {
  const hash = contentHash(input as JsonValue);
  return { revisionId: `rev-${hash.slice("sha256:".length)}`, contentHash: hash };
}

export function createCanonicalRevision(input: CanonicalRevisionInput): CanonicalRevision {
  return { ...input, ...revisionIdentity(input) };
}

export function hasValidRevisionIdentity(revision: CanonicalRevision): boolean {
  const { revisionId, contentHash: hash, ...input } = revision;
  const expected = revisionIdentity(input);
  return revisionId === expected.revisionId && hash === expected.contentHash;
}

function assertStableId(value: string, name: string): void {
  if (!STABLE_ID.test(value)) {
    throw new TypeError(`${name} must be a lowercase stable ID containing only letters, numbers, and hyphens.`);
  }
}

function assertRevisionId(value: string): void {
  if (!REVISION_ID.test(value)) throw new TypeError("revisionId must be a SHA-256-derived revision ID.");
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer.`);
}
