/**
 * Quality report generation for ingestion pipeline.
 *
 * Produces a structured report about the quality of text extraction,
 * OCR coverage, chunking results, and embedding generation.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export type QualityReport = Readonly<{
  sourceId: string;
  fileId: string;
  jobId: string;

  pdfNormalization: Readonly<{
    method: string;
    wasRepaired: boolean;
  }>;

  textExtraction: Readonly<{
    totalPages: number;
    pagesWithText: number;
    pagesNeedingOcr: number;
    totalChars: number;
    avgCharsPerPage: number;
  }>;

  ocr: Readonly<{
    available: boolean;
    pagesOcred: number;
    ocrErrors: readonly string[];
  }>;

  chunking: Readonly<{
    totalChunks: number;
    avgChunkSize: number;
    minChunkSize: number;
    maxChunkSize: number;
  }>;

  embeddings: Readonly<{
    generated: number;
    skipped: number;
    model: string;
    errors: readonly string[];
  }>;

  overall: Readonly<{
    status: "excellent" | "good" | "acceptable" | "poor" | "failed";
    score: number; // 0-100
    warnings: readonly string[];
  }>;
}>;

/**
 * Generates a quality report from pipeline stage results.
 */
export function generateQualityReport(input: {
  sourceId: string;
  fileId: string;
  jobId: string;
  normalization: { method: string; wasRepaired: boolean };
  extraction: { totalPages: number; pagesWithText: number; pagesNeedingOcr: number; totalChars: number };
  ocr: { available: boolean; pagesOcred: number; errors: readonly string[] };
  chunking: { totalChunks: number; chunks: readonly { charCount: number }[] };
  embeddings: { generated: number; skipped: number; model: string; errors: readonly string[] };
}): QualityReport {
  const avgCharsPerPage = input.extraction.totalPages > 0
    ? Math.round(input.extraction.totalChars / input.extraction.totalPages)
    : 0;

  const chunkSizes = input.chunking.chunks.map((c) => c.charCount);
  const avgChunkSize = chunkSizes.length > 0
    ? Math.round(chunkSizes.reduce((a, b) => a + b, 0) / chunkSizes.length)
    : 0;
  const minChunkSize = chunkSizes.length > 0 ? Math.min(...chunkSizes) : 0;
  const maxChunkSize = chunkSizes.length > 0 ? Math.max(...chunkSizes) : 0;

  const { score, status, warnings } = computeOverallQuality(input);

  return {
    sourceId: input.sourceId,
    fileId: input.fileId,
    jobId: input.jobId,

    pdfNormalization: {
      method: input.normalization.method,
      wasRepaired: input.normalization.wasRepaired,
    },

    textExtraction: {
      totalPages: input.extraction.totalPages,
      pagesWithText: input.extraction.pagesWithText,
      pagesNeedingOcr: input.extraction.pagesNeedingOcr,
      totalChars: input.extraction.totalChars,
      avgCharsPerPage,
    },

    ocr: {
      available: input.ocr.available,
      pagesOcred: input.ocr.pagesOcred,
      ocrErrors: input.ocr.errors,
    },

    chunking: {
      totalChunks: input.chunking.totalChunks,
      avgChunkSize,
      minChunkSize,
      maxChunkSize,
    },

    embeddings: {
      generated: input.embeddings.generated,
      skipped: input.embeddings.skipped,
      model: input.embeddings.model,
      errors: input.embeddings.errors,
    },

    overall: { status, score, warnings },
  };
}

/**
 * Computes overall quality score and status.
 */
function computeOverallQuality(input: {
  extraction: { totalPages: number; pagesWithText: number; pagesNeedingOcr: number; totalChars: number };
  ocr: { available: boolean; pagesOcred: number; errors: readonly string[] };
  chunking: { totalChunks: number };
  embeddings: { generated: number; skipped: number; errors: readonly string[] };
}): { score: number; status: QualityReport["overall"]["status"]; warnings: string[] } {
  const warnings: string[] = [];
  let score = 100;

  // No pages extracted at all
  if (input.extraction.totalPages === 0) {
    return { score: 0, status: "failed", warnings: ["No pages extracted from PDF"] };
  }

  // Text coverage penalty
  const textCoverage = input.extraction.pagesWithText / input.extraction.totalPages;
  if (textCoverage < 0.5) {
    score -= 30;
    warnings.push(`Low text coverage: ${(textCoverage * 100).toFixed(0)}% of pages have extractable text`);
  } else if (textCoverage < 0.9) {
    score -= 10;
    warnings.push(`Moderate text coverage: ${(textCoverage * 100).toFixed(0)}% of pages have extractable text`);
  }

  // OCR needed but not available
  if (input.extraction.pagesNeedingOcr > 0 && !input.ocr.available) {
    score -= 20;
    warnings.push(`${input.extraction.pagesNeedingOcr} pages need OCR but ocrmypdf is not available`);
  }

  // OCR errors
  if (input.ocr.errors.length > 0) {
    score -= 10;
    warnings.push(`OCR had ${input.ocr.errors.length} error(s)`);
  }

  // No chunks produced
  if (input.chunking.totalChunks === 0) {
    return { score: 0, status: "failed", warnings: ["No chunks produced — PDF may be empty or unreadable"] };
  }

  // Embedding failures
  const embeddingFailures = input.embeddings.errors.length;
  if (embeddingFailures > 0) {
    score -= Math.min(20, embeddingFailures * 5);
    warnings.push(`${embeddingFailures} embedding generation error(s)`);
  }

  if (input.embeddings.skipped > 0) {
    score -= 5;
    warnings.push(`${input.embeddings.skipped} chunks skipped for embedding generation`);
  }

  // Clamp score
  score = Math.max(0, Math.min(100, score));

  let status: QualityReport["overall"]["status"];
  if (score >= 90) status = "excellent";
  else if (score >= 70) status = "good";
  else if (score >= 50) status = "acceptable";
  else if (score >= 25) status = "poor";
  else status = "failed";

  return { score, status, warnings };
}

/**
 * Saves a quality report as JSON to disk.
 */
export async function saveQualityReport(
  report: QualityReport,
  outputDir: string,
): Promise<string> {
  const outputPath = join(outputDir, "quality-report.json");
  await writeFile(outputPath, JSON.stringify(report, null, 2));
  return outputPath;
}
