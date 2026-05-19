/**
 * Tests for the quality report module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  generateQualityReport,
} from "../../src/worker/ingestion/quality-report.ts";

const baseInput = {
  sourceId: "src-1",
  fileId: "file-1",
  jobId: "job-1",
  normalization: { method: "qpdf", wasRepaired: false },
  extraction: { totalPages: 10, pagesWithText: 10, pagesNeedingOcr: 0, totalChars: 50000 },
  ocr: { available: true, pagesOcred: 0, errors: [] as string[] },
  chunking: { totalChunks: 50, chunks: Array.from({ length: 50 }, () => ({ charCount: 1000 })) },
  embeddings: { generated: 50, skipped: 0, model: "z-embedding", errors: [] as string[] },
};

describe("generateQualityReport", () => {
  it("should return excellent quality for perfect extraction", () => {
    const report = generateQualityReport(baseInput);
    assert.equal(report.overall.status, "excellent");
    assert.equal(report.overall.score, 100);
    assert.equal(report.overall.warnings.length, 0);
  });

  it("should return failed when no pages extracted", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 0, pagesWithText: 0, pagesNeedingOcr: 0, totalChars: 0 },
      chunking: { totalChunks: 0, chunks: [] },
    });
    assert.equal(report.overall.status, "failed");
    assert.equal(report.overall.score, 0);
    assert.ok(report.overall.warnings.some((w) => w.includes("No pages extracted")));
  });

  it("should penalize low text coverage", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 10, pagesWithText: 3, pagesNeedingOcr: 7, totalChars: 5000 },
    });
    assert.ok(report.overall.score < 80);
    assert.ok(report.overall.warnings.some((w) => w.includes("Low text coverage")));
  });

  it("should penalize missing OCR when pages need it", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 10, pagesWithText: 5, pagesNeedingOcr: 5, totalChars: 25000 },
      ocr: { available: false, pagesOcred: 0, errors: [] },
    });
    assert.ok(report.overall.score < 80);
    assert.ok(report.overall.warnings.some((w) => w.includes("ocrmypdf is not available")));
  });

  it("should penalize OCR errors", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 10, pagesWithText: 5, pagesNeedingOcr: 5, totalChars: 25000 },
      ocr: { available: true, pagesOcred: 3, errors: ["OCR timeout"] },
    });
    assert.ok(report.overall.score < 95);
    assert.ok(report.overall.warnings.some((w) => w.includes("OCR had")));
  });

  it("should return failed when no chunks produced", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 1, pagesWithText: 0, pagesNeedingOcr: 1, totalChars: 0 },
      chunking: { totalChunks: 0, chunks: [] },
    });
    assert.equal(report.overall.status, "failed");
    assert.ok(report.overall.warnings.some((w) => w.includes("No chunks produced")));
  });

  it("should penalize embedding errors", () => {
    const report = generateQualityReport({
      ...baseInput,
      embeddings: { generated: 45, skipped: 5, model: "z-embedding", errors: ["timeout", "rate limit"] },
    });
    assert.ok(report.overall.score < 90);
  });

  it("should include correct metadata in report", () => {
    const report = generateQualityReport(baseInput);
    assert.equal(report.sourceId, "src-1");
    assert.equal(report.fileId, "file-1");
    assert.equal(report.jobId, "job-1");
    assert.equal(report.pdfNormalization.method, "qpdf");
    assert.equal(report.textExtraction.totalPages, 10);
    assert.equal(report.chunking.totalChunks, 50);
    assert.equal(report.embeddings.model, "z-embedding");
  });

  it("should compute average chars per page correctly", () => {
    const report = generateQualityReport(baseInput);
    assert.equal(report.textExtraction.avgCharsPerPage, 5000);
  });

  it("should compute chunk size stats correctly", () => {
    const report = generateQualityReport(baseInput);
    assert.equal(report.chunking.avgChunkSize, 1000);
    assert.equal(report.chunking.minChunkSize, 1000);
    assert.equal(report.chunking.maxChunkSize, 1000);
  });

  it("should return good quality for moderate text coverage", () => {
    const report = generateQualityReport({
      ...baseInput,
      extraction: { totalPages: 10, pagesWithText: 9, pagesNeedingOcr: 1, totalChars: 40000 },
      ocr: { available: true, pagesOcred: 1, errors: [] },
    });
    assert.ok(report.overall.score >= 70);
    assert.ok(
      report.overall.status === "good" || report.overall.status === "excellent",
      `Expected good or excellent, got ${report.overall.status}`,
    );
  });
});
