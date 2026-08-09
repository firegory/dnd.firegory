/**
 * Full PDF ingestion pipeline orchestration.
 *
 * Coordinates: normalize → extract text → OCR fallback → chunk → embed → persist → quality report.
 * Integrates with the ingestion job lifecycle from issue #7.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizePdf, isValidPdf } from "./pdf-normalize.ts";
import {
  extractTextFromPdf,
  saveExtractionResults,
} from "./pdf-extract.ts";
import { ocrPdf, isOcrAvailable } from "./pdf-ocr.ts";
import { chunkPages } from "./chunking.ts";
import {
  assessPagesTextQuality,
  findPageQualityFailures,
  MIN_LANGUAGE_QUALITY_CHARACTERS,
} from "./page-quality.ts";
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
}): Promise<PipelineResult> {
  const { jobId, sourceId, fileId, originalPdfPath } = input;
  const artifactsRoot = artifactsRootPath(sourceId, fileId);
  let generationId: string | null = null;
  const jobArtifactsDir = join(artifactsRoot, jobId);

  // Verify job exists and is in correct state
  const job = await getIngestionJob(jobId);
  if (!job) {
    throw new Error(`Job ${jobId} not found`);
  }

  // Mark as processing
  if (!await markJobProcessing(jobId)) {
    throw new Error(`Job ${jobId} was already claimed or is no longer queued`);
  }

  try {
    await cleanupStaleGenerations(fileId, jobId);
    const generation = await createStagedGeneration({
      sourceId,
      fileId,
      jobId,
      artifactsRoot: jobArtifactsDir,
    });
    const stagedGenerationId = generation.id;
    generationId = stagedGenerationId;
    await resetStagedGeneration(stagedGenerationId, jobId);

    // === Stage 1: Validate PDF ===
    await updateJobProgress(jobId, 5);

    const { readFile: readPdfFile } = await import("node:fs/promises");
    const pdfData = await readPdfFile(originalPdfPath);

    if (!isValidPdf(pdfData)) {
      throw new Error("File is not a valid PDF (missing %PDF- header)");
    }

    // === Stage 2: Normalize PDF ===
    await updateJobProgress(jobId, 10);

    const normalizeDir = join(jobArtifactsDir, "normalize");
    const normalizeResult = await normalizePdf(originalPdfPath, normalizeDir);

    // === Stage 3: Extract text ===
    await updateJobProgress(jobId, 20);

    const extractDir = join(jobArtifactsDir, "extract");
    let extractionResult = await extractTextFromPdf(
      normalizeResult.normalizedPath,
      extractDir,
    );
    const sourceLanguage = await getSourceLanguage(sourceId);
    const initialPageQuality = assessPagesTextQuality(extractionResult.pages, sourceLanguage);
    const corruptTextLayerPages = new Set(
      initialPageQuality
        .filter((quality) => quality.status === "corrupt")
        .map((quality) => quality.pageNumber),
    );

    // === Stage 4: OCR fallback ===
    await updateJobProgress(jobId, 35);

    const ocrDir = join(jobArtifactsDir, "ocr");
    let ocrAvailable = false;
    let ocrPagesOcred = 0;
    let ocrErrors: string[] = [];

    try {
      ocrAvailable = await isOcrAvailable();
    } catch {
      ocrAvailable = false;
    }

    const pagesNeedingOcr = [...new Set(extractionResult.pages
      .filter((page) => page.isOcrCandidate || corruptTextLayerPages.has(page.pageNumber))
      .map((page) => page.pageNumber))];
    const ocrReplacementPages = new Set<number>();

    if (pagesNeedingOcr.length > 0 && ocrAvailable) {
      const ocrResult = await ocrPdf(
        normalizeResult.normalizedPath,
        pagesNeedingOcr,
        ocrDir,
      );

      ocrPagesOcred = ocrResult.ocredPages;
      ocrErrors = [...ocrResult.errors];

      // Forced OCR rasterizes selected pages, so re-extract from that PDF
      // rather than trusting the original custom-font text layer or sidecar.
      if (ocrResult.ocrPdfPath) {
        const ocrExtraction = await extractTextFromPdf(
          ocrResult.ocrPdfPath,
          join(ocrDir, "extract"),
        );
        const ocrPages = new Map(ocrExtraction.pages.map((page) => [page.pageNumber, page]));

        // Merge OCR text back into extraction results
        const mergedPages = extractionResult.pages.map((page) => {
          if (!pagesNeedingOcr.includes(page.pageNumber)) return page;

          const ocrPage = ocrPages.get(page.pageNumber);
          const ocrText = ocrPage?.text ?? "";
          const forceReplacement = corruptTextLayerPages.has(page.pageNumber);
          if (ocrText.trim().length > 0
            && (forceReplacement || ocrText.trim().length > page.text.trim().length)) {
            if (!forceReplacement
              || [...ocrText].filter((character) => !/\s/u.test(character)).length
                >= MIN_LANGUAGE_QUALITY_CHARACTERS) {
              ocrReplacementPages.add(page.pageNumber);
            }
            return {
              ...page,
              text: ocrText,
              charCount: ocrText.length,
              isOcrCandidate: ocrPage?.isOcrCandidate ?? false,
            };
          }
          return page;
        });

        extractionResult = {
          ...extractionResult,
          pages: mergedPages,
          totalChars: mergedPages.reduce((sum, p) => sum + p.charCount, 0),
          pagesWithText: mergedPages.filter((p) => p.text.trim().length > 0).length,
          pagesNeedingOcr: mergedPages.filter((p) => p.isOcrCandidate).length,
        };
      }
    }

    const finalPageQuality = assessPagesTextQuality(extractionResult.pages, sourceLanguage);
    const pageQualityFailures = findPageQualityFailures({
      initiallyCorruptPages: corruptTextLayerPages,
      finalQuality: finalPageQuality,
      ocrAvailable,
      ocrReplacementPages,
    });

    await mkdir(jobArtifactsDir, { recursive: true });
    await writeFile(join(jobArtifactsDir, "page-quality.json"), JSON.stringify({
      language: sourceLanguage,
      initial: initialPageQuality,
      final: finalPageQuality,
      failures: pageQualityFailures,
    }, null, 2));
    if (pageQualityFailures.length > 0) {
      const details = pageQualityFailures
        .map((failure) => `page ${failure.pageNumber}: ${failure.reason}`)
        .join("; ");
      throw new Error(`Ingestion page quality validation failed: ${details}`);
    }

    // Save extraction results
    await saveExtractionResults(extractionResult, extractDir);

    await updateJobProgress(jobId, 50);

    // === Stage 5: Chunking ===
    const chunkInputs = extractionResult.pages.map((page) => ({
      pageNumber: page.pageNumber,
      text: page.text,
    }));

    const chunks = chunkPages(chunkInputs);

    // === Stage 5.5: Compute per-chunk bboxes ===
    const chunkBboxes = new Map<number, ChunkBbox>();
    try {
      const pageBboxes = await extractPageBboxes(
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
        const pageBboxMap = computeChunkBboxes(pb, pageChunks);
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

    await updateJobProgress(jobId, 60);

    // === Stage 6: Generate embeddings ===
    const embeddingConfig = getIngestionEmbeddingConfig();
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
        const embeddingResults = await generateEmbeddings(texts, embeddingConfig);

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

    await updateJobProgress(jobId, 80);

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
    const pagesPersisted = await persistPages(pagesToPersist);

    // Persist chunks with embeddings
    let chunksPersisted = 0;
    if (chunksWithEmbeddings.length > 0) {
      chunksPersisted = await persistChunksWithEmbeddings(chunksWithEmbeddings);
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
      chunksPersisted = await persistChunksWithoutEmbeddings(chunkInputs);
    }

    await updateJobProgress(jobId, 90);

    // === Stage 8: Quality report ===
    const qualityReport = generateQualityReport({
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
        available: ocrAvailable,
        pagesOcred: ocrPagesOcred,
        errors: ocrErrors,
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

    await saveQualityReport(qualityReport, jobArtifactsDir);
    if (qualityReport.overall.status === "failed") {
      throw new Error(`Ingestion quality validation failed: ${qualityReport.overall.warnings.join("; ")}`);
    }

    // === Stage 9: Finalize ===
    await activateGeneration(stagedGenerationId);

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
        await discardStagedGeneration(generationId);
      } catch (cleanupError) {
        console.error(
          `[pipeline] Failed to clean staged generation ${generationId}:`,
          cleanupError instanceof Error ? cleanupError.message : cleanupError,
        );
      }
    }
    await markJobFailed(jobId, message);
    throw error;
  }
}
