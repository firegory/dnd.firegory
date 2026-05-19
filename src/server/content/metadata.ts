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
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  shared: boolean;
  ownerUserId: string | null;
  metadata: JsonObject;
  createdByUserId: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
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
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  accessTier: AccessTier;
  ownerUserId?: string | null;
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
  title: string;
  category: SourceCategory;
  edition: SourceEdition;
  language: SourceLanguage;
  access_tier: AccessTier;
  shared: boolean;
  owner_user_id: string | null;
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
        title, category, edition, language, access_tier, shared,
        owner_user_id, metadata, created_by_user_id
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
      RETURNING *`,
      [
        source.title,
        source.category,
        source.edition,
        source.language,
        source.accessTier,
        source.shared,
        source.ownerUserId,
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
    const current = await this.getSource(admin, sourceId);
    const merged = normalizeSourceInput({ ...current, ...input });
    const result = await this.db.query<SourceRow>(
      `UPDATE sources
      SET title = $2,
          category = $3,
          edition = $4,
          language = $5,
          access_tier = $6,
          shared = $7,
          owner_user_id = $8,
          metadata = $9::jsonb,
          updated_at = now()
      WHERE id = $1 AND deleted_at IS NULL
      RETURNING *`,
      [
        sourceId,
        merged.title,
        merged.category,
        merged.edition,
        merged.language,
        merged.accessTier,
        merged.shared,
        merged.ownerUserId,
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

export function normalizeSourceInput(input: CreateSourceMetadataInput): CreateSourceMetadataInput & { shared: boolean } {
  const title = requireTrimmed(input.title, "title");
  validateEnum(input.category, SOURCE_CATEGORIES, "category");
  validateEnum(input.edition, SOURCE_EDITIONS, "edition");
  validateEnum(input.language, SOURCE_LANGUAGES, "language");
  validateEnum(input.accessTier, ACCESS_TIERS, "accessTier");
  const metadata = normalizeMetadata(input.metadata);
  const ownerUserId = input.ownerUserId ? requireTrimmed(input.ownerUserId, "ownerUserId") : null;

  if (input.accessTier === "open") {
    if (ownerUserId) throw new ContentMetadataValidationError("Open/SRD sources cannot have an owner.");
    return { title, category: input.category, edition: input.edition, language: input.language, accessTier: "open", ownerUserId: null, metadata, shared: false };
  }

  if (input.accessTier === "premium") {
    if (ownerUserId) throw new ContentMetadataValidationError("Shared premium sources cannot have an owner.");
    return { title, category: input.category, edition: input.edition, language: input.language, accessTier: "premium", ownerUserId: null, metadata, shared: true };
  }

  if (!ownerUserId) throw new ContentMetadataValidationError("Personal sources require ownerUserId.");
  return { title, category: input.category, edition: input.edition, language: input.language, accessTier: "personal", ownerUserId, metadata, shared: false };
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
  const trimmed = value?.trim();
  if (!trimmed) throw new ContentMetadataValidationError(`${field} is required.`);
  return trimmed;
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

function mapSourceRow(row: SourceRow): SourceMetadataRecord {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    edition: row.edition,
    language: row.language,
    accessTier: row.access_tier,
    shared: row.shared,
    ownerUserId: row.owner_user_id,
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
