import assert from "node:assert/strict";
import test from "node:test";

import { AdminRequiredError, type AdminContext } from "../../src/server/admin/admin-context.ts";
import {
  ContentMetadataService,
  ContentMetadataConflictError,
  ContentMetadataValidationError,
  normalizeFileInput,
  normalizeSourceInput,
  type Queryable,
} from "../../src/server/content/metadata.ts";

const admin: AdminContext = { userId: "admin-1", role: "admin" };
const now = new Date("2026-05-19T00:00:00.000Z");
const checksum = "a".repeat(64);
const ownerUserId = "11111111-1111-4111-8111-111111111111";

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
      canonicalSourceId: null,
      ownerUserId: null,
      publication: {
        code: null,
        title: "Basic Rules",
        publisher: null,
        releaseYear: null,
        revision: null,
        origin: null,
        attribution: null,
        sourcePriority: 0,
        canonicalBookId: null,
      },
      license: null,
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
        ownerUserId,
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
  const db = new RecordingDb([[sourceRow({
    canonical_source_id: "players-handbook-2014-en",
    publication_code: "PHB-2014",
    publication_title: "Player's Handbook",
    publisher: "Wizards of the Coast",
    release_year: 2014,
    publication_revision: "first printing",
    external_origin_url: "https://example.com/books/phb",
    external_origin_id: "phb-2014",
    attribution: "Player's Handbook, Wizards of the Coast",
    source_priority: 100,
    canonical_book_id: "players-handbook",
    license: "All rights reserved",
    created_by_user_id: admin.userId,
  })]]);
  const service = new ContentMetadataService(db);

  const source = await service.createSource(admin, {
    title: "Basic Rules",
    category: "core_rules",
    edition: "5e",
    language: "en",
    accessTier: "open",
    canonicalSourceId: "players-handbook-2014-en",
    publication: {
      code: "PHB-2014",
      title: "Player's Handbook",
      publisher: "Wizards of the Coast",
      releaseYear: 2014,
      revision: "first printing",
      origin: { url: "HTTPS://EXAMPLE.COM:443/books/./phb", id: "phb-2014" },
      attribution: "Player's Handbook, Wizards of the Coast",
      sourcePriority: 100,
      canonicalBookId: "players-handbook",
    },
    license: "All rights reserved",
  });

  assert.equal(source.createdByUserId, admin.userId);
  assert.equal(source.accessTier, "open");
  assert.equal(source.publication.origin?.url, "https://example.com/books/phb");
  assert.match(db.calls[0]?.sql ?? "", /INSERT INTO sources/);
  assert.deepEqual(db.calls[0]?.values, [
    "players-handbook-2014-en",
    "Basic Rules",
    "core_rules",
    "5e",
    "en",
    "open",
    false,
    null,
    "PHB-2014",
    "Player's Handbook",
    "Wizards of the Coast",
    2014,
    "first printing",
    "https://example.com/books/phb",
    "phb-2014",
    "Player's Handbook, Wizards of the Coast",
    100,
    "players-handbook",
    "All rights reserved",
    "{}",
    admin.userId,
  ]);
});

test("content metadata service soft-deletes files without exposing source deletion", async () => {
  const db = new RecordingDb([
    [fileRow({ deleted_at: now })],
  ]);
  const service = new ContentMetadataService(db);

  const deletedFile = await service.deleteFile(admin, "source-1", "file-1");

  assert.equal(deletedFile.deletedAt, now.toISOString());
  assert.match(db.calls[0]?.sql ?? "", /UPDATE files SET deleted_at = now\(\)/);
});

test("content metadata service deep-merges partial publication updates without loss", async () => {
  const current = sourceRow({
    publication_code: "PHB-2014",
    publisher: "Old publisher",
    release_year: 2014,
    external_origin_url: "https://example.com/phb",
    external_origin_id: "phb",
    canonical_book_id: "players-handbook",
  });
  const db = new RecordingDb([[current], [{ ...current, publisher: "New publisher" }]]);
  const service = new ContentMetadataService(db);

  const updated = await service.updateSource(admin, "source-1", {
    publication: { publisher: "New publisher" },
  });

  assert.equal(updated.publication.publisher, "New publisher");
  assert.equal(db.calls[1]?.values?.[9], "PHB-2014");
  assert.equal(db.calls[1]?.values?.[11], "New publisher");
  assert.equal(db.calls[1]?.values?.[14], "https://example.com/phb");
  assert.equal(db.calls[1]?.values?.[15], "phb");
  assert.equal(db.calls[1]?.values?.[18], "players-handbook");
});

test("content metadata service rejects publication null before querying", async () => {
  const db = new RecordingDb([]);
  const service = new ContentMetadataService(db);

  await assert.rejects(
    () => service.updateSource(admin, "source-1", { publication: null } as never),
    (error: unknown) => error instanceof ContentMetadataValidationError
      && error.message === "publication must be a non-null object.",
  );
  assert.equal(db.calls.length, 0);
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
  assert.match(db.calls[0]?.sql ?? "", /SELECT id FROM sources WHERE id = \$1 AND deleted_at IS NULL FOR UPDATE/);
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

test("content metadata service rejects file creation when the source lock finds no active source", async () => {
  const service = new ContentMetadataService(new RecordingDb([[]]));

  await assert.rejects(
    () => service.createFile(admin, {
      sourceId: "source-1",
      originalFilename: "rules.pdf",
      mimeType: "application/pdf",
      checksumSha256: checksum,
      byteSize: 123,
      storagePath: "originals/source-1/rules.pdf",
    }),
    ContentMetadataConflictError,
  );
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

test("publication validation rejects malformed and contradictory metadata", () => {
  const base = {
    title: "Rules",
    category: "core_rules" as const,
    edition: "5.5e" as const,
    language: "en" as const,
    accessTier: "open" as const,
  };
  assert.throws(
    () => normalizeSourceInput({ ...base, publication: { releaseYear: 2014 } }),
    /cannot be earlier than 2024/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, publication: { revision: "reprint" } }),
    /requires publication.releaseYear/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, publication: { origin: { url: "https:\/\/example.com" } } }),
    /must be provided together/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, publication: { origin: { url: "file:\/\/book", id: "book" } } }),
    /absolute HTTP\(S\) URL/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, canonicalSourceId: "Not Stable" }),
    /lowercase stable ID/,
  );
});

test("ownerUserId is UUID-normalized and access invariants remain enforced", () => {
  const base = {
    title: "Rules",
    category: "core_rules" as const,
    edition: "5e" as const,
    language: "en" as const,
  };
  assert.equal(normalizeSourceInput({
    ...base,
    accessTier: "personal",
    ownerUserId: ownerUserId.toUpperCase(),
  }).ownerUserId, ownerUserId);
  assert.throws(
    () => normalizeSourceInput({ ...base, accessTier: "personal", ownerUserId: "user-1" }),
    /ownerUserId must be a UUID/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, accessTier: "open", ownerUserId }),
    /Open\/SRD sources cannot have an owner/,
  );
  assert.throws(
    () => normalizeSourceInput({ ...base, accessTier: "premium", ownerUserId }),
    /Shared premium sources cannot have an owner/,
  );
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
    canonical_source_id: null,
    title: "Basic Rules",
    category: "core_rules",
    edition: "5e",
    language: "en",
    access_tier: "open",
    shared: false,
    owner_user_id: null,
    publication_code: null,
    publication_title: "Basic Rules",
    publisher: null,
    release_year: null,
    publication_revision: null,
    external_origin_url: null,
    external_origin_id: null,
    attribution: null,
    source_priority: 0,
    canonical_book_id: null,
    license: null,
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
