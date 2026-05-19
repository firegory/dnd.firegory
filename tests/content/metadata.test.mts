import assert from "node:assert/strict";
import test from "node:test";

import { AdminRequiredError, type AdminContext } from "../../src/server/admin/admin-context.ts";
import {
  ContentMetadataService,
  ContentMetadataValidationError,
  normalizeFileInput,
  normalizeSourceInput,
  type Queryable,
} from "../../src/server/content/metadata.ts";

const admin: AdminContext = { userId: "admin-1", role: "admin" };
const now = new Date("2026-05-19T00:00:00.000Z");
const checksum = "a".repeat(64);

test("source metadata normalization validates corpus and access tiers", () => {
  assert.deepEqual(
    normalizeSourceInput({
      title: "  Basic Rules  ",
      category: "core_rules",
      edition: "5e",
      language: "en",
      accessTier: "open",
      metadata: { publisher: "Wizards" },
    }),
    {
      title: "Basic Rules",
      category: "core_rules",
      edition: "5e",
      language: "en",
      accessTier: "open",
      ownerUserId: null,
      metadata: { publisher: "Wizards" },
      shared: false,
    },
  );

  assert.equal(
    normalizeSourceInput({
      title: "Premium supplement",
      category: "official_supplement",
      edition: "5.5e",
      language: "ru",
      accessTier: "premium",
    }).shared,
    true,
  );

  assert.throws(
    () =>
      normalizeSourceInput({
        title: "Personal book",
        category: "homebrew",
        edition: "5e",
        language: "en",
        accessTier: "personal",
      }),
    /Personal sources require ownerUserId/,
  );

  assert.throws(
    () =>
      normalizeSourceInput({
        title: "Owned open content",
        category: "core_rules",
        edition: "5e",
        language: "en",
        accessTier: "open",
        ownerUserId: "user-1",
      }),
    /Open\/SRD sources cannot have an owner/,
  );
});

test("file metadata normalization validates immutable upload metadata shape", () => {
  assert.deepEqual(
    normalizeFileInput({
      sourceId: "source-1",
      originalFilename: " rules.pdf ",
      mimeType: " application/pdf ",
      checksumSha256: checksum.toUpperCase(),
      byteSize: 123,
      storagePath: " originals/source-1/file-1.pdf ",
    }),
    {
      sourceId: "source-1",
      originalFilename: "rules.pdf",
      mimeType: "application/pdf",
      checksumSha256: checksum,
      byteSize: 123,
      storagePath: "originals/source-1/file-1.pdf",
      processedArtifactsRoot: null,
    },
  );

  assert.throws(
    () =>
      normalizeFileInput({
        sourceId: "source-1",
        originalFilename: "rules.pdf",
        mimeType: "application/pdf",
        checksumSha256: "not-a-sha",
        byteSize: 123,
        storagePath: "originals/source-1/file-1.pdf",
      }),
    /checksumSha256/,
  );

  assert.throws(
    () =>
      normalizeFileInput({
        sourceId: "source-1",
        originalFilename: "rules.pdf",
        mimeType: "application/pdf",
        checksumSha256: checksum,
        byteSize: 0,
        storagePath: "originals/source-1/file-1.pdf",
      }),
    /byteSize/,
  );
});

test("content metadata service requires injected admin context before CRUD", async () => {
  const db = new RecordingDb([]);
  const service = new ContentMetadataService(db);

  await assert.rejects(
    () =>
      service.createSource(null as never, {
        title: "Basic Rules",
        category: "core_rules",
        edition: "5e",
        language: "en",
        accessTier: "open",
      }),
    AdminRequiredError,
  );
  assert.equal(db.calls.length, 0);
});

test("content metadata service creates admin-owned source records", async () => {
  const db = new RecordingDb([[sourceRow({ created_by_user_id: admin.userId })]]);
  const service = new ContentMetadataService(db);

  const source = await service.createSource(admin, {
    title: "Basic Rules",
    category: "core_rules",
    edition: "5e",
    language: "en",
    accessTier: "open",
  });

  assert.equal(source.createdByUserId, admin.userId);
  assert.equal(source.accessTier, "open");
  assert.match(db.calls[0]?.sql ?? "", /INSERT INTO sources/);
  assert.deepEqual(db.calls[0]?.values?.slice(0, 9), [
    "Basic Rules",
    "core_rules",
    "5e",
    "en",
    "open",
    false,
    null,
    "{}",
    admin.userId,
  ]);
});

test("content metadata service soft-deletes sources and files", async () => {
  const db = new RecordingDb([
    [sourceRow({ deleted_at: now })],
    [fileRow({ deleted_at: now })],
  ]);
  const service = new ContentMetadataService(db);

  const deletedSource = await service.deleteSource(admin, "source-1");
  const deletedFile = await service.deleteFile(admin, "source-1", "file-1");

  assert.equal(deletedSource.deletedAt, now.toISOString());
  assert.equal(deletedFile.deletedAt, now.toISOString());
  assert.match(db.calls[0]?.sql ?? "", /UPDATE sources SET deleted_at = now\(\)/);
  assert.match(db.calls[1]?.sql ?? "", /UPDATE files SET deleted_at = now\(\)/);
});

test("content metadata service creates file records linked to a source", async () => {
  const db = new RecordingDb([[fileRow({ uploaded_by_user_id: admin.userId })]]);
  const service = new ContentMetadataService(db);

  const file = await service.createFile(admin, {
    sourceId: "source-1",
    originalFilename: "rules.pdf",
    mimeType: "application/pdf",
    checksumSha256: checksum,
    byteSize: 42,
    storagePath: "originals/source-1/file-1.pdf",
  });

  assert.equal(file.sourceId, "source-1");
  assert.equal(file.uploadedByUserId, admin.userId);
  assert.match(db.calls[0]?.sql ?? "", /INSERT INTO files/);
  assert.deepEqual(db.calls[0]?.values, [
    "source-1",
    "rules.pdf",
    "application/pdf",
    checksum,
    42,
    "originals/source-1/file-1.pdf",
    null,
    admin.userId,
  ]);
});

test("invalid list filters fail before querying", async () => {
  const db = new RecordingDb([]);
  const service = new ContentMetadataService(db);

  await assert.rejects(
    () => service.listSources(admin, { category: "invalid" as never }),
    ContentMetadataValidationError,
  );
  assert.equal(db.calls.length, 0);
});

class RecordingDb implements Queryable {
  calls: { sql: string; values?: readonly unknown[] }[] = [];
  private readonly queuedRows: unknown[][];

  constructor(queuedRows: unknown[][]) {
    this.queuedRows = queuedRows;
  }

  async query<T = unknown>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }> {
    this.calls.push({ sql, values });
    return { rows: (this.queuedRows.shift() ?? []) as T[] };
  }
}

function sourceRow(overrides = {}) {
  return {
    id: "source-1",
    title: "Basic Rules",
    category: "core_rules",
    edition: "5e",
    language: "en",
    access_tier: "open",
    shared: false,
    owner_user_id: null,
    metadata: {},
    created_by_user_id: null,
    created_at: now,
    updated_at: now,
    deleted_at: null,
    ...overrides,
  };
}

function fileRow(overrides = {}) {
  return {
    id: "file-1",
    source_id: "source-1",
    original_filename: "rules.pdf",
    mime_type: "application/pdf",
    checksum_sha256: checksum,
    byte_size: "42",
    storage_path: "originals/source-1/file-1.pdf",
    processed_artifacts_root: null,
    uploaded_by_user_id: null,
    created_at: now,
    deleted_at: null,
    ...overrides,
  };
}
