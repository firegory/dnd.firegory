import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  computeChecksum,
  originalFilePath,
  artifactsRootPath,
} from "../../src/server/ingestion/paths.ts";

describe("ingestion/storage", () => {
  describe("computeChecksum", () => {
    it("returns SHA-256 hex digest", () => {
      const buffer = Buffer.from("hello world");
      const checksum = computeChecksum(buffer);
      assert.equal(
        checksum,
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
      );
    });

    it("returns different checksums for different content", () => {
      const a = computeChecksum(Buffer.from("foo"));
      const b = computeChecksum(Buffer.from("bar"));
      assert.notEqual(a, b);
    });

    it("returns 64-char lowercase hex", () => {
      const checksum = computeChecksum(Buffer.from("test"));
      assert.match(checksum, /^[0-9a-f]{64}$/);
    });
  });

  describe("originalFilePath", () => {
    it("returns deterministic path under originals/", () => {
      // We can't test getStorageRoot() without env, but we can test the path logic
      // by temporarily setting STORAGE_ROOT
      process.env.STORAGE_ROOT = "/tmp/test-storage";
      const path = originalFilePath("src-123", "file-456");
      assert.equal(path, "/tmp/test-storage/originals/src-123/file-456.pdf");
      delete process.env.STORAGE_ROOT;
    });
  });

  describe("artifactsRootPath", () => {
    it("returns deterministic path under processed/", () => {
      process.env.STORAGE_ROOT = "/tmp/test-storage";
      const path = artifactsRootPath("src-123", "file-456");
      assert.equal(path, "/tmp/test-storage/processed/src-123/file-456");
      delete process.env.STORAGE_ROOT;
    });
  });
});
