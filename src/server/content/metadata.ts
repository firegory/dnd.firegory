import { Pool } from "pg";

import { assertAdminContext, type AdminContext } from "../admin/admin-context.ts";
import {
  ACCESS_TIERS,
  SOURCE_CATEGORIES,
  SOURCE_EDITIONS,
  SOURCE_LANGUAGES,
  type AccessTier,
  type SourceCategory,
  type SourceEdition,
  type SourceLanguage,
} from "../access/retrieval-filter.ts";

export type Queryable = Readonly<{
  query<T = unknown>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

let sharedPool: Pool | null = null;

export function getContentMetadataDb(): Queryable {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for content metadata CRUD.");
  }

  sharedPool ??= new Pool({ connectionString: process.env.DATABASE_URL });
  return sharedPool;
}

export type SourceMetadataRecord = Readonly<{
  id: string;
  canonicalSourceId: string | null;
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  shared: boolean;
  ownerUserId: string | null;
  publication: PublicationMetadata;
  license: string | null;
  metadata: JsonObject;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}>;

export type PublicationOrigin = Readonly<{
  url: string;
  id: string;
}>;

export type PublicationMetadata = Readonly<{
  code: string | null;
  title: string;
  publisher: string | null;
  releaseYear: number | null;
  revision: string | null;
  origin: PublicationOrigin | null;
  attribution: string | null;
  sourcePriority: number;
  canonicalBookId: string | null;
}>;

export type PublicationMetadataInput = Readonly<{
  code?: string | null;
  title?: string;
  publisher?: string | null;
  releaseYear?: number | null;
  revision?: string | null;
  origin?: Readonly<{ url?: string | null; id?: string | null }> | null;
  attribution?: string | null;
  sourcePriority?: number;
  canonicalBookId?: string | null;
}>;

export type FileMetadataRecord = Readonly<{
  id: string;
  sourceId: string;
  originalFilename: string;
  mimeType: string;
  checksumSha256: string;
  byteSize: number;
  storagePath: string;
  processedArtifactsRoot: string | null;
  uploadedByUserId: string | null;
  createdAt: string;
  deletedAt: string | null;
}>;

export type CreateSourceMetadataInput = Readonly<{
  canonicalSourceId?: string | null;
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  ownerUserId?: string | null;
  publication?: PublicationMetadataInput;
  license?: string | null;
  metadata?: JsonObject;
}>;

export type UpdateSourceMetadataInput = Partial<CreateSourceMetadataInput>;

export type CreateFileMetadataInput = Readonly<{
  sourceId: string;
  originalFilename: string;
  mimeType: string;
  checksumSha256: string;
  byteSize: number;
  storagePath: string;
  processedArtifactsRoot?: string | null;
}>;

export type UpdateFileMetadataInput = Partial<Omit<CreateFileMetadataInput, "sourceId">>;

export type ListSourcesOptions = Readonly<{
  includeDeleted?: boolean;
  category?: SourceCategory;
  edition?: SourceEdition;
  language?: SourceLanguage;
  accessTier?: AccessTier;
}>;

export type JsonObject = Readonly<Record<string, unknown>>;

type SourceRow = Readonly<{
  id: string;
  canonical_source_id: string | null;
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  access_tier: AccessTier;
  shared: boolean;
  owner_user_id: string | null;
  publication_code: string | null;
  publication_title: string;
  publisher: string | null;
  release_year: number | null;
  publication_revision: string | null;
  external_origin_url: string | null;
  external_origin_id: string | null;
  attribution: string | null;
  source_priority: number;
  canonical_book_id: string | null;
  license: string | null;
  metadata: JsonObject;
  created_by_user_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  deleted_at: Date | string | null;
}>;

type FileRow = Readonly<{
  id: string;
  source_id: string;
  original_filename: string;
  mime_type: string;
  checksum_sha256: string;
  byte_size: string | number;
  storage_path: string;
  processed_artifacts_root: string | null;
  uploaded_by_user_id: string | null;
  created_at: Date | string;
  deleted_at: Date | string | null;
}>;

export class ContentMetadataValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentMetadataValidationError";
  }
}

export class ContentMetadataNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContentMetadataNotFoundError";
  }
}

export class ContentMetadataService {
  private readonly db: Queryable;

  constructor(db: Queryable = getContentMetadataDb()) {
    this.db = db;
  }

  async listSources(admin: AdminContext, options: ListSourcesOptions = {}): Promise<SourceMetadataRecord[]> {
    assertAdminContext(admin);
    validateOptionalEnum(options.category, SOURCE_CATEGORIES, "category");
    validateOptionalEnum(options.edition, SOURCE_EDITIONS, "edition");
    validateOptionalEnum(options.language, SOURCE_LANGUAGES, "language");
    validateOptionalEnum(options.accessTier, ACCESS_TIERS, "accessTier");

    const clauses: string[] = [];
    const values: unknown[] = [];
    if (!options.includeDeleted) clauses.push("deleted_at IS NULL");
    addOptionalFilter(clauses, values, "category", options.category);
    addOptionalFilter(clauses, values, "edition", options.edition);
    addOptionalFilter(clauses, values, "language", options.language);
    addOptionalFilter(clauses, values, "access_tier", options.accessTier);

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await this.db.query<SourceRow>(
      `SELECT * FROM sources ${where} ORDER BY updated_at DESC, created_at DESC`,
      values,
    );
    return result.rows.map(mapSourceRow);
  }

  async getSource(admin: AdminContext, sourceId: string): Promise<SourceMetadataRecord> {
    assertAdminContext(admin);
    validateId(sourceId, "sourceId");
    const result = await this.db.query<SourceRow>(
      "SELECT * FROM sources WHERE id = $1 AND deleted_at IS NULL",
      [sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("Source metadata record was not found.");
    return mapSourceRow(row);
  }

  async createSource(admin: AdminContext, input: CreateSourceMetadataInput): Promise<SourceMetadataRecord> {
    assertAdminContext(admin);
    const source = normalizeSourceInput(input);
    const result = await this.db.query<SourceRow>(
      `INSERT INTO sources (
        canonical_source_id, title, category, edition, language, access_tier, shared,
        owner_user_id, publication_code, publication_title, publisher, release_year,
        publication_revision, external_origin_url, external_origin_id, attribution,
        source_priority, canonical_book_id, license, metadata, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                $14, $15, $16, $17, $18, $19, $20::jsonb, $21)
      RETURNING *`,
      [
        source.canonicalSourceId,
        source.title,
        source.category,
        source.edition,
        source.language,
        source.accessTier,
        source.shared,
        source.ownerUserId,
        source.publication.code,
        source.publication.title,
        source.publication.publisher,
        source.publication.releaseYear,
        source.publication.revision,
        source.publication.origin?.url ?? null,
        source.publication.origin?.id ?? null,
        source.publication.attribution,
        source.publication.sourcePriority,
        source.publication.canonicalBookId,
        source.license,
        JSON.stringify(source.metadata),
        admin.userId,
      ],
    );
    return mapSourceRow(result.rows[0]);
  }

  async updateSource(
    admin: AdminContext,
    sourceId: string,
    input: UpdateSourceMetadataInput,
  ): Promise<SourceMetadataRecord> {
    assertAdminContext(admin);
    if (!isRecord(input)) throw new ContentMetadataValidationError("source update must be an object.");
    if ("publication" in input && input.publication !== undefined && !isRecord(input.publication)) {
      throw new ContentMetadataValidationError("publication must be a non-null object.");
    }
    const current = await this.getSource(admin, sourceId);
    const publication = input.publication === undefined
      ? current.publication
      : {
          ...current.publication,
          ...input.publication,
          origin: input.publication.origin === undefined ? current.publication.origin : input.publication.origin,
        };
    const merged = normalizeSourceInput({ ...current, ...input, publication });
    const result = await this.db.query<SourceRow>(
      `UPDATE sources
      SET canonical_source_id = $2,
          title = $3,
          category = $4,
          edition = $5,
          language = $6,
          access_tier = $7,
          shared = $8,
          owner_user_id = $9,
          publication_code = $10,
          publication_title = $11,
          publisher = $12,
          release_year = $13,
          publication_revision = $14,
          external_origin_url = $15,
          external_origin_id = $16,
          attribution = $17,
          source_priority = $18,
          canonical_book_id = $19,
          license = $20,
          metadata = $21::jsonb,
          updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
      [
        sourceId,
        merged.canonicalSourceId,
        merged.title,
        merged.category,
        merged.edition,
        merged.language,
        merged.accessTier,
        merged.shared,
        merged.ownerUserId,
        merged.publication.code,
        merged.publication.title,
        merged.publication.publisher,
        merged.publication.releaseYear,
        merged.publication.revision,
        merged.publication.origin?.url ?? null,
        merged.publication.origin?.id ?? null,
        merged.publication.attribution,
        merged.publication.sourcePriority,
        merged.publication.canonicalBookId,
        merged.license,
        JSON.stringify(merged.metadata),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("Source metadata record was not found.");
    return mapSourceRow(row);
  }

  async deleteSource(admin: AdminContext, sourceId: string): Promise<SourceMetadataRecord> {
    assertAdminContext(admin);
    validateId(sourceId, "sourceId");
    const result = await this.db.query<SourceRow>(
      `UPDATE sources SET deleted_at = now(), updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
      [sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("Source metadata record was not found.");
    return mapSourceRow(row);
  }

  async listFiles(admin: AdminContext, sourceId: string, includeDeleted = false): Promise<FileMetadataRecord[]> {
    assertAdminContext(admin);
    validateId(sourceId, "sourceId");
    const result = await this.db.query<FileRow>(
      `SELECT * FROM files WHERE source_id = $1${includeDeleted ? "" : " AND deleted_at IS NULL"} ORDER BY created_at DESC`,
      [sourceId],
    );
    return result.rows.map(mapFileRow);
  }

  async getFile(admin: AdminContext, sourceId: string, fileId: string): Promise<FileMetadataRecord> {
    assertAdminContext(admin);
    validateId(sourceId, "sourceId");
    validateId(fileId, "fileId");
    const result = await this.db.query<FileRow>(
      "SELECT * FROM files WHERE id = $1 AND source_id = $2 AND deleted_at IS NULL",
      [fileId, sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("File metadata record was not found.");
    return mapFileRow(row);
  }

  async createFile(admin: AdminContext, input: CreateFileMetadataInput): Promise<FileMetadataRecord> {
    assertAdminContext(admin);
    const file = normalizeFileInput(input);
    const result = await this.db.query<FileRow>(
      `INSERT INTO files (
        source_id, original_filename, mime_type, checksum_sha256,
        byte_size, storage_path, processed_artifacts_root, uploaded_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING *`,
      [
        file.sourceId,
        file.originalFilename,
        file.mimeType,
        file.checksumSha256,
        file.byteSize,
        file.storagePath,
        file.processedArtifactsRoot,
        admin.userId,
      ],
    );
    return mapFileRow(result.rows[0]);
  }

  async updateFile(
    admin: AdminContext,
    sourceId: string,
    fileId: string,
    input: UpdateFileMetadataInput,
  ): Promise<FileMetadataRecord> {
    assertAdminContext(admin);
    const current = await this.getFile(admin, sourceId, fileId);
    const merged = normalizeFileInput({ ...current, sourceId, ...input });
    const result = await this.db.query<FileRow>(
      `UPDATE files
      SET original_filename = $3,
          mime_type = $4,
          checksum_sha256 = $5,
          byte_size = $6,
          storage_path = $7,
          processed_artifacts_root = $8
      WHERE id = $1 AND source_id = $2 AND deleted_at IS NULL
      RETURNING *`,
      [
        fileId,
        sourceId,
        merged.originalFilename,
        merged.mimeType,
        merged.checksumSha256,
        merged.byteSize,
        merged.storagePath,
        merged.processedArtifactsRoot,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("File metadata record was not found.");
    return mapFileRow(row);
  }

  async deleteFile(admin: AdminContext, sourceId: string, fileId: string): Promise<FileMetadataRecord> {
    assertAdminContext(admin);
    validateId(sourceId, "sourceId");
    validateId(fileId, "fileId");
    const result = await this.db.query<FileRow>(
      `UPDATE files SET deleted_at = now()
      WHERE id = $1 AND source_id = $2 AND deleted_at IS NULL
      RETURNING *`,
      [fileId, sourceId],
    );
    const row = result.rows[0];
    if (!row) throw new ContentMetadataNotFoundError("File metadata record was not found.");
    return mapFileRow(row);
  }
}

export function normalizeSourceInput(input: CreateSourceMetadataInput): Omit<Required<CreateSourceMetadataInput>, "publication"> & { publication: PublicationMetadata; shared: boolean } {
  const title = requireTrimmed(input.title, "title");
  validateEnum(input.category, SOURCE_CATEGORIES, "category");
  validateEnum(input.edition, SOURCE_EDITIONS, "edition");
  validateEnum(input.language, SOURCE_LANGUAGES, "language");
  validateEnum(input.accessTier, ACCESS_TIERS, "accessTier");
  const metadata = normalizeMetadata(input.metadata);
  const canonicalSourceId = optionalStableId(input.canonicalSourceId, "canonicalSourceId");
  const publication = normalizePublication(input.publication, title, input.edition);
  const license = optionalTrimmed(input.license, "license");
  const ownerUserId = input.ownerUserId ? requireUuid(input.ownerUserId, "ownerUserId") : null;

  if (input.accessTier === "open") {
    if (ownerUserId) throw new ContentMetadataValidationError("Open/SRD sources cannot have an owner.");
    return { canonicalSourceId, title, category: input.category, edition: input.edition, language: input.language, accessTier: "open", ownerUserId: null, publication, license, metadata, shared: false };
  }

  if (input.accessTier === "premium") {
    if (ownerUserId) throw new ContentMetadataValidationError("Shared premium sources cannot have an owner.");
    return { canonicalSourceId, title, category: input.category, edition: input.edition, language: input.language, accessTier: "premium", ownerUserId: null, publication, license, metadata, shared: true };
  }

  if (!ownerUserId) throw new ContentMetadataValidationError("Personal sources require ownerUserId.");
  return { canonicalSourceId, title, category: input.category, edition: input.edition, language: input.language, accessTier: "personal", ownerUserId, publication, license, metadata, shared: false };
}

function normalizePublication(input: PublicationMetadataInput | undefined, sourceTitle: string, edition: SourceEdition): PublicationMetadata {
  const publication = input === undefined ? {} : input;
  if (!isRecord(publication)) throw new ContentMetadataValidationError("publication must be a non-null object.");
  const allowed = new Set(["code", "title", "publisher", "releaseYear", "revision", "origin", "attribution", "sourcePriority", "canonicalBookId"]);
  for (const key of Object.keys(publication)) {
    if (!allowed.has(key)) throw new ContentMetadataValidationError(`publication.${key} is not supported.`);
  }

  const releaseYear = publication.releaseYear ?? null;
  if (releaseYear !== null && (!Number.isSafeInteger(releaseYear) || releaseYear < 1974 || releaseYear > 2100)) {
    throw new ContentMetadataValidationError("publication.releaseYear must be an integer between 1974 and 2100.");
  }
  if (edition === "5.5e" && releaseYear !== null && releaseYear < 2024) {
    throw new ContentMetadataValidationError("D&D 5.5e publication.releaseYear cannot be earlier than 2024.");
  }

  const revision = optionalTrimmed(publication.revision, "publication.revision");
  if (revision && releaseYear === null) {
    throw new ContentMetadataValidationError("publication.revision requires publication.releaseYear.");
  }

  const sourcePriority = publication.sourcePriority ?? 0;
  if (!Number.isSafeInteger(sourcePriority) || sourcePriority < 0 || sourcePriority > 1000) {
    throw new ContentMetadataValidationError("publication.sourcePriority must be an integer between 0 and 1000.");
  }

  const code = optionalTrimmed(publication.code, "publication.code");
  if (code && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(code)) {
    throw new ContentMetadataValidationError("publication.code may contain only letters, numbers, dots, underscores, and hyphens.");
  }

  return {
    code,
    title: publication.title === undefined ? sourceTitle : requireTrimmed(publication.title, "publication.title"),
    publisher: optionalTrimmed(publication.publisher, "publication.publisher"),
    releaseYear,
    revision,
    origin: normalizeOrigin(publication.origin),
    attribution: optionalTrimmed(publication.attribution, "publication.attribution"),
    sourcePriority,
    canonicalBookId: optionalStableId(publication.canonicalBookId, "publication.canonicalBookId"),
  };
}

function normalizeOrigin(origin: PublicationMetadataInput["origin"]): PublicationOrigin | null {
  if (origin === undefined || origin === null) return null;
  if (!isRecord(origin)) throw new ContentMetadataValidationError("publication.origin must be an object.");
  for (const key of Object.keys(origin)) {
    if (key !== "url" && key !== "id") throw new ContentMetadataValidationError(`publication.origin.${key} is not supported.`);
  }
  const url = optionalTrimmed(origin.url, "publication.origin.url");
  const id = optionalTrimmed(origin.id, "publication.origin.id");
  if ((url === null) !== (id === null)) {
    throw new ContentMetadataValidationError("publication.origin.url and publication.origin.id must be provided together.");
  }
  if (!url || !id) return null;
  const normalizedUrl = url.replace(/^https?:/i, (scheme) => scheme.toLowerCase());
  let parsed: URL;
  try {
    parsed = new URL(normalizedUrl);
  } catch {
    throw new ContentMetadataValidationError("publication.origin.url must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ContentMetadataValidationError("publication.origin.url must be a valid HTTP(S) URL.");
  }
  return { url: normalizedUrl, id };
}

export function normalizeFileInput(input: CreateFileMetadataInput): Required<CreateFileMetadataInput> {
  const checksumSha256 = requireTrimmed(input.checksumSha256, "checksumSha256").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(checksumSha256)) {
    throw new ContentMetadataValidationError("checksumSha256 must be a 64 character lowercase hex digest.");
  }

  if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0) {
    throw new ContentMetadataValidationError("byteSize must be a positive safe integer.");
  }

  return {
    sourceId: requireTrimmed(input.sourceId, "sourceId"),
    originalFilename: requireTrimmed(input.originalFilename, "originalFilename"),
    mimeType: requireTrimmed(input.mimeType, "mimeType"),
    checksumSha256,
    byteSize: input.byteSize,
    storagePath: requireTrimmed(input.storagePath, "storagePath"),
    processedArtifactsRoot: input.processedArtifactsRoot?.trim() || null,
  };
}

function addOptionalFilter(clauses: string[], values: unknown[], column: string, value: unknown): void {
  if (value === undefined) return;
  values.push(value);
  clauses.push(`${column} = $${values.length}`);
}

function validateId(value: string, field: string): void {
  requireTrimmed(value, field);
}

function requireTrimmed(value: string, field: string): string {
  if (typeof value !== "string") throw new ContentMetadataValidationError(`${field} must be a string.`);
  const trimmed = value?.trim();
  if (!trimmed) throw new ContentMetadataValidationError(`${field} is required.`);
  return trimmed;
}

function optionalTrimmed(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") throw new ContentMetadataValidationError(`${field} must be a string or null.`);
  return requireTrimmed(value, field);
}

function optionalStableId(value: string | null | undefined, field: string): string | null {
  const id = optionalTrimmed(value, field);
  if (id !== null && !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(id)) {
    throw new ContentMetadataValidationError(`${field} must be a lowercase stable ID.`);
  }
  return id;
}

function requireUuid(value: string, field: string): string {
  const uuid = requireTrimmed(value, field).toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new ContentMetadataValidationError(`${field} must be a UUID.`);
  }
  return uuid;
}

function validateEnum<T extends readonly string[]>(value: string, allowed: T, field: string): asserts value is T[number] {
  if (!allowed.includes(value)) {
    throw new ContentMetadataValidationError(`${field} must be one of: ${allowed.join(", ")}.`);
  }
}

function validateOptionalEnum<T extends readonly string[]>(value: string | undefined, allowed: T, field: string): void {
  if (value !== undefined) validateEnum(value, allowed, field);
}

function normalizeMetadata(metadata: JsonObject | undefined): JsonObject {
  if (metadata === undefined) return {};
  if (!metadata || Array.isArray(metadata) || typeof metadata !== "object") {
    throw new ContentMetadataValidationError("metadata must be a JSON object.");
  }
  return metadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mapSourceRow(row: SourceRow): SourceMetadataRecord {
  return {
    id: row.id,
    canonicalSourceId: row.canonical_source_id,
    title: row.title,
    category: row.category,
    edition: row.edition,
    language: row.language,
    accessTier: row.access_tier,
    shared: row.shared,
    ownerUserId: row.owner_user_id,
    publication: {
      code: row.publication_code,
      title: row.publication_title,
      publisher: row.publisher,
      releaseYear: row.release_year,
      revision: row.publication_revision,
      origin: row.external_origin_url && row.external_origin_id
        ? { url: row.external_origin_url, id: row.external_origin_id }
        : null,
      attribution: row.attribution,
      sourcePriority: row.source_priority,
      canonicalBookId: row.canonical_book_id,
    },
    license: row.license,
    metadata: row.metadata,
    createdByUserId: row.created_by_user_id,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

function mapFileRow(row: FileRow): FileMetadataRecord {
  return {
    id: row.id,
    sourceId: row.source_id,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    checksumSha256: row.checksum_sha256,
    byteSize: typeof row.byte_size === "number" ? row.byte_size : Number(row.byte_size),
    storagePath: row.storage_path,
    processedArtifactsRoot: row.processed_artifacts_root,
    uploadedByUserId: row.uploaded_by_user_id,
    createdAt: toIso(row.created_at),
    deletedAt: toIsoOrNull(row.deleted_at),
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toIsoOrNull(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}
