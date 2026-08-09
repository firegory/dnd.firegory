/**
 * Full PDF ingestion pipeline orchestration.
 *
 * Coordinates: normalize → extract text → OCR fallback → chunk → embed → persist → quality report.
 * Integrates with the ingestion job lifecycle from issue #7.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizePdf } from "./pdf-normalize.ts";
import {
  extractTextFromPdf,
  saveExtractionResults,
} from "./pdf-extract.ts";
import { chunkPages } from "./chunking.ts";
import { assertBoundedFile, validateOriginalPdf } from "./file-safety.ts";
import { MAX_PDF_INPUT_BYTES } from "../../server/ingestion/limits.ts";
import { recoverPdfText } from "./text-recovery.ts";
import { extractPageBboxes, computeChunkBboxes, type ChunkBbox } from "./bbox.ts";
import {
  generateEmbeddings,
  persistChunksWithEmbeddings,
  persistChunksWithoutEmbeddings,
  persistPages,
  getIngestionEmbeddingConfig,
} from "../../server/embeddings/provider.ts";
import {
  generateQualityReport,
  saveQualityReport,
  type QualityReport,
} from "./quality-report.ts";
import {
  markJobProcessing,
  markJobFailed,
  updateJobProgress,
  getIngestionJob,
  getSourceLanguage,
} from "../../server/ingestion/storage.ts";
import { artifactsRootPath } from "../../server/ingestion/paths.ts";
import {
  activateGeneration,
  ActivationStateUnknownError,
  cleanupStaleGenerations,
  createStagedGeneration,
  discardStagedGeneration,
  resetStagedGeneration,
} from "../../server/ingestion/generations.ts";

export type PipelineResult = Readonly<{
  jobId: string;
  sourceId: string;
  fileId: string;
  generationId: string;
  artifactsRoot: string;
  qualityReport: QualityReport;
  chunksPersisted: number;
  pagesPersisted: number;
}>;

const pipelineDefaults = {
  artifactsRootPath,
  getIngestionJob,
  markJobProcessing,
  cleanupStaleGenerations,
  createStagedGeneration,
  resetStagedGeneration,
  updateJobProgress,
  validateOriginalPdf,
  normalizePdf,
  assertBoundedFile,
  extractTextFromPdf,
  getSourceLanguage,
  recoverPdfText,
  saveExtractionResults,
  chunkPages,
  extractPageBboxes,
  computeChunkBboxes,
  getIngestionEmbeddingConfig,
  generateEmbeddings,
  persistPages,
  persistChunksWithEmbeddings,
  persistChunksWithoutEmbeddings,
  generateQualityReport,
  saveQualityReport,
  activateGeneration,
  discardStagedGeneration,
  markJobFailed,
};

export type PipelineDependencies = typeof pipelineDefaults;

/**
 * Runs the full ingestion pipeline for a given job.
 *
 * @param jobId The ingestion job ID
 * @param sourceId The source ID
 * @param fileId The file ID
 * @param originalPdfPath Path to the original PDF on disk
 */
export async function runPipeline(input: {
  jobId: string;
  sourceId: string;
  fileId: string;
  originalPdfPath: string;
}, overrides: Partial<PipelineDependencies> = {}): Promise<PipelineResult> {
  const dependencies = { ...pipelineDefaults, ...overrides };
  const { jobId, sourceId, fileId, originalPdfPath } = input;
  const artifactsRoot = dependencies.artifactsRootPath(sourceId, fileId);
  let generationId: string | null = null;
  const jobArtifactsDir = join(artifactsRoot, jobId);

  // Verify job exists and is in correct state
  const job = await dependencies.getIngestionJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Mark as processing
  if (!await dependencies.markJobProcessing(jobId)) {
    throw new Error(`Job ${jobId} was already claimed or is no longer queued`);
  }

  try {
    await dependencies.cleanupStaleGenerations(fileId, jobId);
    const generation = await dependencies.createStagedGeneration({
      sourceId,
      fileId,
      jobId,
      artifactsRoot: jobArtifactsDir,
    });
    const stagedGenerationId = generation.id;
    generationId = stagedGenerationId;
    await dependencies.resetStagedGeneration(stagedGenerationId, jobId);

    // === Stage 1: Validate PDF ===
    await dependencies.updateJobProgress(jobId, 5);

    await dependencies.validateOriginalPdf(originalPdfPath);

    // === Stage 2: Normalize PDF ===
    await dependencies.updateJobProgress(jobId, 10);

    const normalizeDir = join(jobArtifactsDir, "normalize");
    const normalizeResult = await dependencies.normalizePdf(originalPdfPath, normalizeDir);
    await dependencies.assertBoundedFile(normalizeResult.normalizedPath, MAX_PDF_INPUT_BYTES, "Normalized PDF");

    // === Stage 3: Extract text ===
    await dependencies.updateJobProgress(jobId, 20);

    const extractDir = join(jobArtifactsDir, "extract");
    const initialExtraction = await dependencies.extractTextFromPdf(
      normalizeResult.normalizedPath,
      extractDir,
    );
    const sourceLanguage = await dependencies.getSourceLanguage(sourceId);

    // === Stage 4: OCR fallback ===
    await dependencies.updateJobProgress(jobId, 35);

    const ocrDir = join(jobArtifactsDir, "ocr");
    const recovery = await dependencies.recoverPdfText({
      pdfPath: normalizeResult.normalizedPath,
      ocrDir,
      extraction: initialExtraction,
      language: sourceLanguage,
    });
    const extractionResult = recovery.extraction;

    await mkdir(jobArtifactsDir, { recursive: true });
    await writeFile(join(jobArtifactsDir, "page-quality.json"), JSON.stringify({
      language: sourceLanguage,
      initial: recovery.initialQuality,
      final: recovery.finalQuality,
      requestedPages: recovery.requestedPages,
      replacedPages: recovery.replacedPages,
      ocrFailureReason: recovery.ocrFailureReason,
      failures: recovery.failures,
    }, null, 2));
    if (recovery.failures.length > 0) {
      const details = recovery.failures
        .map((failure) => `page ${failure.pageNumber}: ${failure.reason}`)
        .join("; ");
      throw new Error(`Ingestion page quality validation failed: ${details}`);
    }

    // Save extraction results
    await dependencies.saveExtractionResults(extractionResult, extractDir);

    await dependencies.updateJobProgress(jobId, 50);

    // === Stage 5: Chunking ===
    const chunkInputs = extractionResult.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
    }));

    const chunks = dependencies.chunkPages(chunkInputs);

    // === Stage 5.5: Compute per-chunk bboxes ===
    const chunkBboxes = new Map<number, ChunkBbox>();
    try {
      const pageBboxes = await dependencies.extractPageBboxes(
        normalizeResult.normalizedPath,
        extractionResult.totalPages,
      );

      const chunksByPage = new Map<number, typeof chunks>();
      for (const c of chunks) {
        const arr = chunksByPage.get(c.pageNumber) ?? [];
        arr.push(c);
        chunksByPage.set(c.pageNumber, arr);
      }

      for (const [pageNum, pageChunks] of chunksByPage) {
        const pb = pageBboxes.get(pageNum);
        if (!pb) continue;
        const pageBboxMap = dependencies.computeChunkBboxes(pb, pageChunks);
        for (const [chunkIdx, bbox] of pageBboxMap) {
          chunkBboxes.set(chunkIdx, bbox);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[pipeline] Bbox extraction failed (non-fatal): ${msg}`);
    }

    // Save chunks as JSONL
    const chunksJsonlPath = join(jobArtifactsDir, "chunks.jsonl");
    const chunksJsonl = chunks.map((c) =>
      JSON.stringify({
        chunk_index: c.chunkIndex,
        page_number: c.pageNumber,
        section_heading: c.sectionHeading,
        text: c.text,
        quote_text: c.quoteText,
        text_span_start: c.textSpanStart,
        text_span_end: c.textSpanEnd,
        char_count: c.charCount,
        bbox: chunkBboxes.get(c.chunkIndex) ?? null,
      }),
    ).join("\n");
    await mkdir(jobArtifactsDir, { recursive: true });
    await writeFile(chunksJsonlPath, chunksJsonl + "\n");

    await dependencies.updateJobProgress(jobId, 60);

    // === Stage 6: Generate embeddings ===
    const embeddingConfig = dependencies.getIngestionEmbeddingConfig();
    let embeddingsGenerated = 0;
    let embeddingsSkipped = 0;
    const embeddingErrors: string[] = [];
    let embeddingModel = embeddingConfig.model;

    const chunksWithEmbeddings: Array<{
      sourceId: string;
      generationId: string;
      fileId: string;
      jobId: string;
      chunkIndex: number;
      text: string;
      quoteText: string;
      pageNumber: number;
      sectionHeading: string | null;
      textSpanStart: number;
      textSpanEnd: number;
      charCount: number;
      embedding: readonly number[];
      embeddingModel: string;
      bbox: ChunkBbox | null;
    }> = [];

    const canGenerateEmbeddings = chunks.length > 0
      && (embeddingConfig.provider === "ollama" || Boolean(embeddingConfig.apiKey));

    if (canGenerateEmbeddings) {
      try {
        const texts = chunks.map((c) => c.text);
        const embeddingResults = await dependencies.generateEmbeddings(texts, embeddingConfig);

        for (let i = 0; i < chunks.length; i++) {
          if (i < embeddingResults.length) {
            chunksWithEmbeddings.push({
              generationId: stagedGenerationId,
              sourceId,
              fileId,
              jobId,
              chunkIndex: chunks[i].chunkIndex,
              text: chunks[i].text,
              quoteText: chunks[i].quoteText,
              pageNumber: chunks[i].pageNumber,
              sectionHeading: chunks[i].sectionHeading,
              textSpanStart: chunks[i].textSpanStart,
              textSpanEnd: chunks[i].textSpanEnd,
              charCount: chunks[i].charCount,
              embedding: embeddingResults[i].embedding,
              embeddingModel: embeddingResults[i].model,
              bbox: chunkBboxes.get(chunks[i].chunkIndex) ?? null,
            });
            embeddingsGenerated++;
          } else {
            embeddingsSkipped++;
          }
        }
        embeddingModel = embeddingResults[0]?.model ?? embeddingConfig.model;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        embeddingErrors.push(`Embedding generation failed: ${msg}`);
        embeddingsSkipped = chunks.length;
      }
    } else {
      embeddingsSkipped = chunks.length;
      if (embeddingConfig.provider !== "ollama" && !embeddingConfig.apiKey) {
        embeddingErrors.push("ZAI_API_KEY not configured — embeddings skipped");
      }
    }

    await dependencies.updateJobProgress(jobId, 80);

    // === Stage 7: Persist to database ===
    // Persist pages
    const pagesToPersist = extractionResult.pages.map((page) => ({
      generationId: stagedGenerationId,
      sourceId,
      fileId,
      jobId,
      pageNumber: page.pageNumber,
      text: page.text,
      sectionHeading: null as string | null,
    }));
    const pagesPersisted = await dependencies.persistPages(pagesToPersist);

    // Persist chunks with embeddings
    let chunksPersisted = 0;
    if (chunksWithEmbeddings.length > 0) {
      chunksPersisted = await dependencies.persistChunksWithEmbeddings(chunksWithEmbeddings);
    }

    // Persist chunks without embeddings (if embedding failed but we still want chunks for full-text search)
    if (embeddingsSkipped > 0 && chunksWithEmbeddings.length === 0) {
      const chunkInputs = chunks.map((c) => ({
        generationId: stagedGenerationId,
        sourceId,
        fileId,
        jobId,
        chunkIndex: c.chunkIndex,
        text: c.text,
        quoteText: c.quoteText,
        sectionHeading: c.sectionHeading,
        pageNumber: c.pageNumber,
        textSpanStart: c.textSpanStart,
        textSpanEnd: c.textSpanEnd,
        bbox: chunkBboxes.get(c.chunkIndex) ?? null,
      }));
      chunksPersisted = await dependencies.persistChunksWithoutEmbeddings(chunkInputs);
    }

    await dependencies.updateJobProgress(jobId, 90);

    // === Stage 8: Quality report ===
    const qualityReport = dependencies.generateQualityReport({
      sourceId,
      fileId,
      jobId,
      normalization: {
        method: normalizeResult.method,
        wasRepaired: normalizeResult.wasRepaired,
      },
      extraction: {
        totalPages: extractionResult.totalPages,
        pagesWithText: extractionResult.pagesWithText,
        pagesNeedingOcr: extractionResult.pagesNeedingOcr,
        totalChars: extractionResult.totalChars,
      },
      ocr: {
        available: recovery.ocrAvailable,
        pagesOcred: recovery.ocrPagesOcred,
        errors: recovery.ocrErrors,
      },
      chunking: {
        totalChunks: chunks.length,
        chunks,
      },
      embeddings: {
        generated: embeddingsGenerated,
        skipped: embeddingsSkipped,
        model: embeddingModel,
        errors: embeddingErrors,
      },
    });

    await dependencies.saveQualityReport(qualityReport, jobArtifactsDir);
    if (qualityReport.overall.status === "failed") {
      throw new Error(`Ingestion quality validation failed: ${qualityReport.overall.warnings.join("; ")}`);
    }

    // === Stage 9: Finalize ===
    await dependencies.activateGeneration(stagedGenerationId);

    return {
      jobId,
      sourceId,
      fileId,
      generationId: stagedGenerationId,
      artifactsRoot,
      qualityReport,
      chunksPersisted,
      pagesPersisted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (generationId && !(error instanceof ActivationStateUnknownError)) {
      try {
        await dependencies.discardStagedGeneration(generationId);
      } catch (cleanupError) {
        console.error(
          `[pipeline] Failed to clean staged generation ${generationId}:`,
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
      }
    }
    await dependencies.markJobFailed(jobId, message);
    throw error;
  }
}
