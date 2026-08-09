import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MAX_OCR_OUTPUT_BYTES } from "../../src/server/ingestion/limits.ts";
import type { ExtractionResult } from "../../src/worker/ingestion/pdf-extract.ts";
import { runPipeline, type PipelineDependencies } from "../../src/worker/ingestion/pipeline.ts";
import { recoverPdfText } from "../../src/worker/ingestion/text-recovery.ts";

const validRussian = "Книга заклинаний волшебника содержит подробные описания известных заклинаний. На каждом уровне персонаж подготавливает заклинания и использует ячейки подходящего уровня.";
const corrupt = "«В>р>=<= ... К=ига ... В<лшеб=ик 1-г> ур>в=я» ".repeat(8);

function extraction(texts: readonly string[]): ExtractionResult {
  const pages = texts.map((text, index) => ({ pageNumber: index + 1, text, charCount: text.length, isOcrCandidate: false }));
  return {
    pages,
    totalPages: pages.length,
    totalChars: pages.reduce((sum, page) => sum + page.charCount, 0),
    pagesWithText: pages.length,
    pagesNeedingOcr: 0,
  };
}

type FailureMode = "timeout" | "oversize" | "language" | "punctuation";

async function pipelineFixture(root: string, mode: "success" | FailureMode) {
  const original = join(root, "original.pdf");
  const ocrOutput = join(root, "ocr-output.pdf");
  await writeFile(original, "%PDF-1.7 test");
  let activeGeneration = "generation-old";
  let persistCalls = 0;
  let discarded: string | null = null;
  let failedSummary: string | null = null;
  let requestedPages: readonly number[] = [];

  const dependencies: Partial<PipelineDependencies> = {
    artifactsRootPath: () => join(root, "artifacts"),
    getIngestionJob: async () => ({ id: "job-1", status: "queued" } as never),
    markJobProcessing: async () => true,
    cleanupStaleGenerations: async () => 0,
    createStagedGeneration: async () => ({ id: "generation-new" } as never),
    resetStagedGeneration: async () => undefined,
    updateJobProgress: async () => undefined,
    normalizePdf: async () => ({ normalizedPath: original, method: "none", wasRepaired: false }),
    extractTextFromPdf: async (_path, outputDir) => {
      await mkdir(outputDir, { recursive: true });
      return extraction([validRussian, corrupt, "Краткая подпись"]);
    },
    getSourceLanguage: async () => "ru",
    recoverPdfText: async (input) => recoverPdfText({
      ...input,
      dependencies: {
        getOcrAvailability: async () => mode === "language"
          ? { available: false, reason: "Missing Tesseract language data: rus" }
          : { available: true, reason: null },
        ocrPdf: async (_path, pages) => {
          requestedPages = pages;
          if (mode === "timeout") {
            return { ocrPdfPath: null, ocredPages: 0, totalRequested: pages.length, errors: ["OCR command timed out"] };
          }
          await writeFile(ocrOutput, "%PDF-1.7 OCR");
          if (mode === "oversize") await truncate(ocrOutput, MAX_OCR_OUTPUT_BYTES + 1);
          return { ocrPdfPath: ocrOutput, ocredPages: pages.length, totalRequested: pages.length, errors: [] };
        },
        extractTextFromPdf: async () => extraction([
          "must not replace page one",
          mode === "punctuation" ? ">=<=1234567890".repeat(40) : validRussian,
          "must not replace page three",
        ]),
      },
    }),
    extractPageBboxes: async () => new Map(),
    getIngestionEmbeddingConfig: () => ({
      provider: "zai", apiKey: "", baseUrl: "", model: "test", dimensions: 3, keepAlive: "",
    }),
    persistPages: async (pages) => {
      persistCalls++;
      if (mode === "success") {
        assert.deepEqual(pages.map((page) => page.text), [validRussian, validRussian, "Краткая подпись"]);
      }
      return pages.length;
    },
    persistChunksWithoutEmbeddings: async (chunks) => {
      persistCalls++;
      return chunks.length;
    },
    activateGeneration: async (generationId) => {
      activeGeneration = generationId;
    },
    discardStagedGeneration: async (generationId) => {
      discarded = generationId;
      return true;
    },
    markJobFailed: async (_jobId, summary) => {
      failedSummary = summary;
    },
  };

  return {
    original,
    dependencies,
    state: () => ({ activeGeneration, persistCalls, discarded, failedSummary, requestedPages }),
  };
}

test("behavioral pipeline persists a valid selected-page OCR replacement then activates", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-behavior-"));
  try {
    const fixture = await pipelineFixture(root, "success");
    const result = await runPipeline({
      jobId: "job-1", sourceId: "source-1", fileId: "file-1", originalPdfPath: fixture.original,
    }, fixture.dependencies);
    assert.equal(result.pagesPersisted, 3);
    assert.deepEqual(fixture.state().requestedPages, [2]);
    assert.equal(fixture.state().activeGeneration, "generation-new");
    assert.equal(fixture.state().discarded, null);
    assert.equal(fixture.state().persistCalls, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["timeout", "oversize", "language", "punctuation"] as const) {
  test(`behavioral pipeline fails ${mode} before persistence and preserves active generation`, async () => {
    const root = await mkdtemp(join(tmpdir(), "pipeline-behavior-"));
    try {
      const fixture = await pipelineFixture(root, mode);
      await assert.rejects(runPipeline({
        jobId: "job-1", sourceId: "source-1", fileId: "file-1", originalPdfPath: fixture.original,
      }, fixture.dependencies), /Ingestion page quality validation failed/);
      const state = fixture.state();
      assert.equal(state.persistCalls, 0);
      assert.equal(state.activeGeneration, "generation-old");
      assert.equal(state.discarded, "generation-new");
      assert.ok(state.failedSummary);
      assert.doesNotMatch(state.failedSummary, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      if (mode === "timeout") assert.match(state.failedSummary, /OCR command timed out/);
      if (mode === "oversize") assert.match(state.failedSummary, /OCR output PDF exceeds size limit/);
      if (mode === "language") assert.match(state.failedSummary, /Missing Tesseract language data: rus/);
      if (mode === "punctuation") assert.match(state.failedSummary, /insufficient letter or word evidence/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("behavioral pipeline rejects a symlinked source before tools or persistence and preserves active generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pipeline-symlink-"));
  try {
    const fixture = await pipelineFixture(root, "success");
    const target = join(root, "target.pdf");
    await writeFile(target, "%PDF-1.7 target");
    await rm(fixture.original);
    await symlink(target, fixture.original);
    await assert.rejects(runPipeline({
      jobId: "job-1", sourceId: "source-1", fileId: "file-1", originalPdfPath: fixture.original,
    }, fixture.dependencies), /ELOOP|symbolic link/);
    assert.equal(fixture.state().persistCalls, 0);
    assert.equal(fixture.state().activeGeneration, "generation-old");
    assert.equal(fixture.state().discarded, "generation-new");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
