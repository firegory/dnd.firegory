import { join } from "node:path";
import { rm } from "node:fs/promises";

import type { SourceLanguage } from "../../server/access/retrieval-filter.ts";
import { MAX_OCR_OUTPUT_BYTES } from "../../server/ingestion/limits.ts";
import { assertBoundedFile } from "./file-safety.ts";
import { extractTextFromPdf, type ExtractionResult } from "./pdf-extract.ts";
import { getOcrAvailability, ocrPdf } from "./pdf-ocr.ts";
import {
  assessPagesTextQuality,
  findPageQualityFailures,
  type PageTextQuality,
} from "./page-quality.ts";

export type TextRecoveryDependencies = Readonly<{
  getOcrAvailability: typeof getOcrAvailability;
  ocrPdf: typeof ocrPdf;
  extractTextFromPdf: typeof extractTextFromPdf;
  assertBoundedFile: typeof assertBoundedFile;
}>;

const defaultDependencies: TextRecoveryDependencies = {
  getOcrAvailability,
  ocrPdf,
  extractTextFromPdf,
  assertBoundedFile,
};

export type TextRecoveryResult = Readonly<{
  extraction: ExtractionResult;
  initialQuality: readonly PageTextQuality[];
  finalQuality: readonly PageTextQuality[];
  requestedPages: readonly number[];
  replacedPages: readonly number[];
  ocrAvailable: boolean;
  ocrPagesOcred: number;
  ocrErrors: readonly string[];
  ocrFailureReason: string | null;
  failures: readonly { pageNumber: number; reason: string }[];
}>;

export async function recoverPdfText(input: Readonly<{
  pdfPath: string;
  ocrDir: string;
  extraction: ExtractionResult;
  language: SourceLanguage;
  dependencies?: Partial<TextRecoveryDependencies>;
}>): Promise<TextRecoveryResult> {
  const dependencies = { ...defaultDependencies, ...input.dependencies };
  const initialQuality = assessPagesTextQuality(input.extraction.pages, input.language);
  const corruptPages = new Set(initialQuality
    .filter((quality) => quality.status === "corrupt")
    .map((quality) => quality.pageNumber));
  const requestedPages = [...new Set(input.extraction.pages
    .filter((page) => page.isOcrCandidate || corruptPages.has(page.pageNumber))
    .map((page) => page.pageNumber))];
  const replacedPages = new Set<number>();
  let extraction = input.extraction;
  let ocrPagesOcred = 0;
  let ocrErrors: readonly string[] = [];

  let availability: Awaited<ReturnType<typeof getOcrAvailability>>;
  try {
    availability = await dependencies.getOcrAvailability();
  } catch {
    availability = { available: false, reason: "OCR runtime check failed" };
  }

  if (requestedPages.length > 0 && availability.available) {
    let outputPath: string | null = null;
    try {
      const result = await dependencies.ocrPdf(input.pdfPath, requestedPages, input.ocrDir);
      outputPath = result.ocrPdfPath;
      ocrPagesOcred = result.ocredPages;
      ocrErrors = result.errors;
      if (result.ocrPdfPath) {
        await dependencies.assertBoundedFile(result.ocrPdfPath, MAX_OCR_OUTPUT_BYTES, "OCR output PDF");
        const ocrExtraction = await dependencies.extractTextFromPdf(
          result.ocrPdfPath,
          join(input.ocrDir, "extract"),
        );
        const ocrPages = new Map(ocrExtraction.pages.map((page) => [page.pageNumber, page]));
        const requested = new Set(requestedPages);
        const mergedPages = extraction.pages.map((page) => {
          if (!requested.has(page.pageNumber)) return page;
          const ocrPage = ocrPages.get(page.pageNumber);
          const ocrText = ocrPage?.text ?? "";
          const forceReplacement = corruptPages.has(page.pageNumber);
          if (ocrText.trim().length === 0
            || (!forceReplacement && ocrText.trim().length <= page.text.trim().length)) return page;
          replacedPages.add(page.pageNumber);
          return {
            ...page,
            text: ocrText,
            charCount: ocrText.length,
            isOcrCandidate: ocrPage?.isOcrCandidate ?? false,
          };
        });
        extraction = summarizeExtraction(extraction, mergedPages);
      }
    } catch (error) {
      ocrErrors = [safeRecoveryError(error)];
      if (outputPath) await rm(outputPath, { force: true }).catch(() => undefined);
    }
  }

  const finalQuality = assessPagesTextQuality(extraction.pages, input.language);
  const ocrFailureReason = ocrErrors[0] ?? availability.reason;
  const failures = findPageQualityFailures({
    initiallyCorruptPages: corruptPages,
    finalQuality,
    ocrAvailable: availability.available,
    ocrFailureReason,
    ocrReplacementPages: replacedPages,
  });
  return {
    extraction,
    initialQuality,
    finalQuality,
    requestedPages,
    replacedPages: [...replacedPages],
    ocrAvailable: availability.available,
    ocrPagesOcred,
    ocrErrors,
    ocrFailureReason,
    failures,
  };
}

function safeRecoveryError(error: unknown): string {
  if (error instanceof Error && /^OCR output PDF exceeds size limit of \d+ bytes$/u.test(error.message)) {
    return error.message;
  }
  return "OCR output processing failed";
}

function summarizeExtraction(
  original: ExtractionResult,
  pages: ExtractionResult["pages"],
): ExtractionResult {
  return {
    ...original,
    pages,
    totalChars: pages.reduce((sum, page) => sum + page.charCount, 0),
    pagesWithText: pages.filter((page) => page.text.trim().length > 0).length,
    pagesNeedingOcr: pages.filter((page) => page.isOcrCandidate).length,
  };
}
