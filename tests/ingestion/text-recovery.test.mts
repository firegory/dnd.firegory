import assert from "node:assert/strict";
import { access, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_OCR_OUTPUT_BYTES } from "../../src/server/ingestion/limits.ts";
import type { ExtractionResult } from "../../src/worker/ingestion/pdf-extract.ts";
import { recoverPdfText } from "../../src/worker/ingestion/text-recovery.ts";

const validRussian = "Книга заклинаний волшебника содержит подробные описания известных заклинаний. На каждом уровне персонаж подготавливает заклинания и использует ячейки подходящего уровня.";
const corrupt = "«В>р>=<= ... К=ига ... В<лшеб=ик 1-г> ур>в=я» ".repeat(8);

function extraction(texts: readonly string[], candidates: readonly number[] = []): ExtractionResult {
  const pages = texts.map((text, index) => ({
    pageNumber: index + 1,
    text,
    charCount: text.length,
    isOcrCandidate: candidates.includes(index + 1),
  }));
  return {
    pages,
    totalPages: pages.length,
    totalChars: pages.reduce((sum, page) => sum + page.charCount, 0),
    pagesWithText: pages.filter((page) => page.text.trim()).length,
    pagesNeedingOcr: candidates.length,
  };
}

test("OCRs only selected pages and replaces them without reordering neighbors", async () => {
  const root = await mkdtemp(join(tmpdir(), "text-recovery-"));
  const output = join(root, "ocr.pdf");
  let requested: readonly number[] = [];
  try {
    const result = await recoverPdfText({
      pdfPath: join(root, "input.pdf"),
      ocrDir: root,
      extraction: extraction([validRussian, corrupt, "Краткая подпись"]),
      language: "ru",
      dependencies: {
        getOcrAvailability: async () => ({ available: true, reason: null }),
        ocrPdf: async (_path, pages) => {
          requested = pages;
          await writeFile(output, "%PDF-1.7 OCR");
          return { ocrPdfPath: output, ocredPages: pages.length, totalRequested: pages.length, errors: [] };
        },
        extractTextFromPdf: async () => extraction(["wrong page one", validRussian, "wrong page three"]),
      },
    });
    assert.deepEqual(requested, [2]);
    assert.deepEqual(result.requestedPages, [2]);
    assert.deepEqual(result.replacedPages, [2]);
    assert.deepEqual(result.extraction.pages.map((page) => page.text), [validRussian, validRussian, "Краткая подпись"]);
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects punctuation OCR replacement after re-scoring", async () => {
  const root = await mkdtemp(join(tmpdir(), "text-recovery-"));
  const output = join(root, "ocr.pdf");
  try {
    const result = await recoverPdfText({
      pdfPath: join(root, "input.pdf"),
      ocrDir: root,
      extraction: extraction([corrupt]),
      language: "ru",
      dependencies: {
        getOcrAvailability: async () => ({ available: true, reason: null }),
        ocrPdf: async () => {
          await writeFile(output, "%PDF-1.7 OCR");
          return { ocrPdfPath: output, ocredPages: 1, totalRequested: 1, errors: [] };
        },
        extractTextFromPdf: async () => extraction([">=<=1234567890".repeat(40)]),
      },
    });
    assert.equal(result.failures.length, 1);
    assert.match(result.failures[0].reason, /insufficient letter or word evidence/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports timeout and missing Russian language data without invoking persistence", async () => {
  let ocrCalls = 0;
  const missing = await recoverPdfText({
    pdfPath: "unused.pdf",
    ocrDir: "unused",
    extraction: extraction([corrupt]),
    language: "ru",
    dependencies: {
      getOcrAvailability: async () => ({ available: false, reason: "Missing Tesseract language data: rus" }),
      ocrPdf: async () => {
        ocrCalls++;
        throw new Error("must not run");
      },
    },
  });
  assert.equal(ocrCalls, 0);
  assert.match(missing.failures[0].reason, /Missing Tesseract language data: rus/);

  const timeout = await recoverPdfText({
    pdfPath: "unused.pdf",
    ocrDir: "unused",
    extraction: extraction([corrupt]),
    language: "ru",
    dependencies: {
      getOcrAvailability: async () => ({ available: true, reason: null }),
      ocrPdf: async () => ({ ocrPdfPath: null, ocredPages: 0, totalRequested: 1, errors: ["OCR command timed out"] }),
    },
  });
  assert.match(timeout.failures[0].reason, /OCR command timed out/);
});

test("rejects and removes oversized OCR output before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "text-recovery-"));
  const output = join(root, "ocr.pdf");
  let extractionCalls = 0;
  try {
    await writeFile(output, "%PDF-");
    await truncate(output, MAX_OCR_OUTPUT_BYTES + 1);
    const result = await recoverPdfText({
      pdfPath: join(root, "input.pdf"),
      ocrDir: root,
      extraction: extraction([corrupt]),
      language: "ru",
      dependencies: {
        getOcrAvailability: async () => ({ available: true, reason: null }),
        ocrPdf: async () => ({ ocrPdfPath: output, ocredPages: 1, totalRequested: 1, errors: [] }),
        extractTextFromPdf: async () => {
          extractionCalls++;
          return extraction([validRussian]);
        },
      },
    });
    assert.equal(extractionCalls, 0);
    assert.match(result.failures[0].reason, /OCR output PDF exceeds size limit/);
    await assert.rejects(access(output), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
