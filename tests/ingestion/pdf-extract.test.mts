/**
 * Tests for PDF normalization module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { isValidPdf } from "../../src/worker/ingestion/pdf-normalize.ts";

describe("isValidPdf", () => {
  it("should return true for valid PDF magic bytes", () => {
    const pdf = Buffer.from("%PDF-1.7 rest of file content here");
    assert.equal(isValidPdf(pdf), true);
  });

  it("should return true for PDF with version 2.0", () => {
    const pdf = Buffer.from("%PDF-2.0 some content");
    assert.equal(isValidPdf(pdf), true);
  });

  it("should return false for empty buffer", () => {
    assert.equal(isValidPdf(Buffer.alloc(0)), false);
  });

  it("should return false for non-PDF content", () => {
    assert.equal(isValidPdf(Buffer.from("<html>")), false);
    assert.equal(isValidPdf(Buffer.from("Hello world")), false);
    assert.equal(isValidPdf(Buffer.from("PK")), false); // ZIP
  });

  it("should return false for short buffers", () => {
    assert.equal(isValidPdf(Buffer.from("%PDF")), false); // 4 bytes, need 5
  });

  it("should return false for PDF magic not at start", () => {
    const data = Buffer.from("  %PDF-1.7");
    assert.equal(isValidPdf(data), false);
  });
});
