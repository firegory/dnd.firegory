/**
 * Tests for ingestion lifecycle and admin actions validation.
 *
 * These tests cover the validation and pure-logic parts of the ingestion
 * pipeline that don't require a live database. They verify:
 * - Source metadata normalization and validation rules
 * - File metadata normalization and validation rules
 * - Access tier consistency rules (open/premium/personal)
 * - Ingestion paths/checksum utilities
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeSourceInput,
  normalizeFileInput,
  ContentMetadataValidationError,
} from "../../src/server/content/metadata.ts";
import { computeChecksum } from "../../src/server/ingestion/paths.ts";

describe("ingestion: source metadata validation", () => {
  it("validates a complete open source input", () => {
    const result = normalizeSourceInput({
      title: "Basic Rules",
      category: "core_rules",
      edition: "5e",
      language: "en",
      accessTier: "open",
    });

    assert.equal(result.title, "Basic Rules");
    assert.equal(result.category, "core_rules");
    assert.equal(result.edition, "5e");
    assert.equal(result.language, "en");
    assert.equal(result.accessTier, "open");
    assert.equal(result.shared, false);
    assert.equal(result.ownerUserId, null);
  });

  it("validates a shared premium source input", () => {
    const result = normalizeSourceInput({
      title: "Player's Handbook",
      category: "core_rules",
      edition: "5e",
      language: "en",
      accessTier: "premium",
    });

    assert.equal(result.accessTier, "premium");
    assert.equal(result.shared, true);
    assert.equal(result.ownerUserId, null);
  });

  it("validates a personal source with owner", () => {
    const result = normalizeSourceInput({
      title: "My Homebrew Campaign",
      category: "homebrew",
      edition: "5.5e",
      language: "ru",
      accessTier: "personal",
      ownerUserId: "user-123",
    });

    assert.equal(result.accessTier, "personal");
    assert.equal(result.shared, false);
    assert.equal(result.ownerUserId, "user-123");
  });

  it("rejects open source with ownerUserId", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Open Source",
          category: "core_rules",
          edition: "5e",
          language: "en",
          accessTier: "open",
          ownerUserId: "user-123",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects premium source with ownerUserId", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Premium Source",
          category: "official_supplement",
          edition: "5e",
          language: "en",
          accessTier: "premium",
          ownerUserId: "user-123",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects personal source without ownerUserId", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Personal Source",
          category: "homebrew",
          edition: "5e",
          language: "en",
          accessTier: "personal",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects empty title", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "  ",
          category: "core_rules",
          edition: "5e",
          language: "en",
          accessTier: "open",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects invalid category", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Test",
          category: "invalid" as "core_rules",
          edition: "5e",
          language: "en",
          accessTier: "open",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects invalid edition", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Test",
          category: "core_rules",
          edition: "4e" as "5e",
          language: "en",
          accessTier: "open",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects invalid language", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Test",
          category: "core_rules",
          edition: "5e",
          language: "de" as "en",
          accessTier: "open",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects invalid access tier", () => {
    assert.throws(
      () =>
        normalizeSourceInput({
          title: "Test",
          category: "core_rules",
          edition: "5e",
          language: "en",
          accessTier: "superadmin" as "open",
        }),
      ContentMetadataValidationError,
    );
  });

  it("accepts metadata object", () => {
    const result = normalizeSourceInput({
      title: "Test",
      category: "core_rules",
      edition: "5e",
      language: "en",
      accessTier: "open",
      metadata: { isbn: "978-0-123456-78-9", pages: 320 },
    });

    assert.deepEqual(result.metadata, { isbn: "978-0-123456-78-9", pages: 320 });
  });
});

describe("ingestion: file metadata validation", () => {
  it("validates a complete file input", () => {
    const result = normalizeFileInput({
      sourceId: "src-1",
      originalFilename: "test.pdf",
      mimeType: "application/pdf",
      checksumSha256: "a".repeat(64),
      byteSize: 1024,
      storagePath: "/storage/originals/src-1/file-1.pdf",
    });

    assert.equal(result.sourceId, "src-1");
    assert.equal(result.originalFilename, "test.pdf");
    assert.equal(result.mimeType, "application/pdf");
    assert.equal(result.checksumSha256, "a".repeat(64));
    assert.equal(result.byteSize, 1024);
    assert.equal(result.processedArtifactsRoot, null);
  });

  it("rejects invalid checksum format", () => {
    assert.throws(
      () =>
        normalizeFileInput({
          sourceId: "src-1",
          originalFilename: "test.pdf",
          mimeType: "application/pdf",
          checksumSha256: "not-a-hex-checksum",
          byteSize: 1024,
          storagePath: "/storage/test.pdf",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects non-positive byteSize", () => {
    assert.throws(
      () =>
        normalizeFileInput({
          sourceId: "src-1",
          originalFilename: "test.pdf",
          mimeType: "application/pdf",
          checksumSha256: "a".repeat(64),
          byteSize: 0,
          storagePath: "/storage/test.pdf",
        }),
      ContentMetadataValidationError,
    );
  });

  it("rejects negative byteSize", () => {
    assert.throws(
      () =>
        normalizeFileInput({
          sourceId: "src-1",
          originalFilename: "test.pdf",
          mimeType: "application/pdf",
          checksumSha256: "a".repeat(64),
          byteSize: -100,
          storagePath: "/storage/test.pdf",
        }),
      ContentMetadataValidationError,
    );
  });

  it("accepts optional processedArtifactsRoot", () => {
    const result = normalizeFileInput({
      sourceId: "src-1",
      originalFilename: "test.pdf",
      mimeType: "application/pdf",
      checksumSha256: "a".repeat(64),
      byteSize: 2048,
      storagePath: "/storage/test.pdf",
      processedArtifactsRoot: "/storage/processed/src-1/job-1",
    });

    assert.equal(result.processedArtifactsRoot, "/storage/processed/src-1/job-1");
  });
});

describe("ingestion: checksum utility", () => {
  it("computes consistent SHA-256 for same input", () => {
    const data = Buffer.from("test PDF content");
    const hash1 = computeChecksum(data);
    const hash2 = computeChecksum(data);

    assert.equal(hash1, hash2);
    assert.equal(hash1.length, 64, "SHA-256 hex digest should be 64 chars");
    assert.match(hash1, /^[0-9a-f]{64}$/, "Should be lowercase hex");
  });

  it("produces different checksums for different inputs", () => {
    const hash1 = computeChecksum(Buffer.from("content A"));
    const hash2 = computeChecksum(Buffer.from("content B"));

    assert.notEqual(hash1, hash2);
  });

  it("handles empty buffer", () => {
    const hash = computeChecksum(Buffer.alloc(0));
    assert.equal(hash, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });
});
