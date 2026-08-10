/**
 * PDF text extraction with page mapping.
 *
 * Uses pdftotext (poppler-utils) to extract text from each page.
 * Produces a per-page text map suitable for downstream chunking.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { getPdfPageCount } from "./pdf-normalize.ts";
import { isCommandAvailable } from "./dependencies.ts";
import { assertBoundedFile, readBoundedUtf8, writeJsonLinesBounded } from "./file-safety.ts";
import { runMonitoredTool } from "./tool-runner.ts";
import {
  MAX_EXTRACTED_DOCUMENT_BYTES,
  MAX_EXTRACTED_PAGE_BYTES,
  MAX_PDF_PAGES,
  PDF_TOOL_TIMEOUT_MS,
  TOOL_STDIO_MAX_BYTES,
} from "../../server/ingestion/limits.ts";

type PdfExec = (
  command: string,
  args: readonly string[],
  options: typeof boundedPdfToolOptions,
) => Promise<unknown>;

type ExtractDependencies = Readonly<{
  isCommandAvailable: typeof isCommandAvailable;
  getPdfPageCount: typeof getPdfPageCount;
  execFile: PdfExec;
}>;

export type ExtractedPage = Readonly<{
  pageNumber: number;
  text: string;
  charCount: number;
  isOcrCandidate: boolean;
}>;

export type ExtractionResult = Readonly<{
  pages: readonly ExtractedPage[];
  totalPages: number;
  totalChars: number;
  pagesWithText: number;
  pagesNeedingOcr: number;
}>;

/**
 * Threshold: pages with fewer than this many characters are considered
 * OCR candidates (scanned images, blank pages, etc.).
 */
const MIN_TEXT_CHARS_FOR_QUALITY = 50;

/**
 * Extracts text from a PDF file, page by page, using pdftotext.
 *
 * Falls back to a whole-file extraction if per-page extraction fails.
 * Returns structured results with OCR candidacy detection.
 */
export async function extractTextFromPdf(
  pdfPath: string,
  outputDir: string,
  overrides: Partial<ExtractDependencies> = {},
): Promise<ExtractionResult> {
  const dependencies: ExtractDependencies = {
    isCommandAvailable,
    getPdfPageCount,
    execFile: async (command, args) => {
      const outputPath = args.at(-1);
      await runMonitoredTool(command, args, {
        timeoutMs: PDF_TOOL_TIMEOUT_MS,
        maxStdoutBytes: TOOL_STDIO_MAX_BYTES,
        monitorLimits: outputPath ? [
          {
            path: outputPath,
            maxBytes: args.includes("-f") ? MAX_EXTRACTED_PAGE_BYTES : MAX_EXTRACTED_DOCUMENT_BYTES,
          },
          { path: outputDir, maxBytes: MAX_EXTRACTED_DOCUMENT_BYTES },
        ] : [],
      });
    },
    ...overrides,
  };
  await mkdir(outputDir, { recursive: true });

  const missingCommands: string[] = [];
  if (!(await dependencies.isCommandAvailable("pdfinfo"))) missingCommands.push("pdfinfo");
  if (!(await dependencies.isCommandAvailable("pdftotext"))) missingCommands.push("pdftotext");
  if (missingCommands.length > 0) {
    throw new Error(
      `Missing PDF text extraction dependency: ${missingCommands.join(", ")} (install poppler-utils).`,
    );
  }

  const pages = await extractPagesIndividually(pdfPath, outputDir, dependencies);

  if (pages.length === 0) {
    // Fallback: try extracting the entire file as one page
    const wholeText = await extractWholeFile(pdfPath, outputDir, dependencies);
    if (wholeText.trim().length > 0) {
      return {
        pages: [{
          pageNumber: 1,
          text: wholeText,
          charCount: wholeText.length,
          isOcrCandidate: wholeText.trim().length < MIN_TEXT_CHARS_FOR_QUALITY,
        }],
        totalPages: 1,
        totalChars: wholeText.length,
        pagesWithText: wholeText.trim().length > 0 ? 1 : 0,
        pagesNeedingOcr: wholeText.trim().length < MIN_TEXT_CHARS_FOR_QUALITY ? 1 : 0,
      };
    }

    // No text at all — entire document needs OCR
    return {
      pages: [],
      totalPages: 0,
      totalChars: 0,
      pagesWithText: 0,
      pagesNeedingOcr: 0,
    };
  }

  const totalChars = pages.reduce((sum, p) => sum + p.charCount, 0);
  const pagesWithText = pages.filter((p) => p.text.trim().length > 0).length;
  const pagesNeedingOcr = pages.filter((p) => p.isOcrCandidate).length;

  return {
    pages,
    totalPages: pages.length,
    totalChars,
    pagesWithText,
    pagesNeedingOcr,
  };
}

/**
 * Extracts text from each page individually using pdftotext -f/-l flags.
 */
async function extractPagesIndividually(
  pdfPath: string,
  outputDir: string,
  dependencies: ExtractDependencies,
): Promise<ExtractedPage[]> {
  // First get page count
  const pageCount = await dependencies.getPdfPageCount(pdfPath);
  if (pageCount === null || pageCount === 0) {
    return [];
  }
  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(`PDF page count exceeds limit of ${MAX_PDF_PAGES}`);
  }

  const pages: ExtractedPage[] = [];
  let extractedBytes = 0;

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const pageOutputPath = join(outputDir, `page-${pageNum}.txt`);
    try {
      await dependencies.execFile("pdftotext", [
        "-enc", "UTF-8",
        "-layout",
        "-f", String(pageNum),
        "-l", String(pageNum),
        pdfPath,
        pageOutputPath,
      ], boundedPdfToolOptions);
    } catch {
      await rm(pageOutputPath, { force: true });
      // pdftotext failed for this page — mark as OCR candidate
      pages.push({
        pageNumber: pageNum,
        text: "",
        charCount: 0,
        isOcrCandidate: true,
      });
      continue;
    }

    let pageBytes: number;
    try {
      pageBytes = await assertBoundedFile(pageOutputPath, MAX_EXTRACTED_PAGE_BYTES, `Extracted page ${pageNum}`);
    } catch {
      await rm(pageOutputPath, { force: true });
      pages.push({ pageNumber: pageNum, text: "", charCount: 0, isOcrCandidate: true });
      continue;
    }
    extractedBytes += pageBytes;
    if (extractedBytes > MAX_EXTRACTED_DOCUMENT_BYTES) {
      throw new Error(`Extracted document exceeds size limit of ${MAX_EXTRACTED_DOCUMENT_BYTES} bytes`);
    }
    const text = await readBoundedUtf8(pageOutputPath, MAX_EXTRACTED_PAGE_BYTES, `Extracted page ${pageNum}`);
    const charCount = text.length;
    const isOcrCandidate = text.trim().length < MIN_TEXT_CHARS_FOR_QUALITY;

    pages.push({ pageNumber: pageNum, text, charCount, isOcrCandidate });
  }

  return pages;
}

/**
 * Extracts text from the entire PDF as a single text block (fallback).
 */
async function extractWholeFile(
  pdfPath: string,
  outputDir: string,
  dependencies: ExtractDependencies,
): Promise<string> {
  const outputPath = join(outputDir, "full-text.txt");
  try {
    await dependencies.execFile("pdftotext", [
      "-enc", "UTF-8",
      "-layout",
      pdfPath,
      outputPath,
    ], boundedPdfToolOptions);
    return await readBoundedUtf8(outputPath, MAX_EXTRACTED_DOCUMENT_BYTES, "Extracted PDF text");
  } catch {
    await rm(outputPath, { force: true });
    return "";
  }
}

export const boundedPdfToolOptions = {
  timeout: PDF_TOOL_TIMEOUT_MS,
  maxBuffer: TOOL_STDIO_MAX_BYTES,
  killSignal: "SIGKILL" as const,
};

/**
 * Saves extracted text as JSONL (one JSON object per page).
 */
export async function saveExtractionResults(
  result: ExtractionResult,
  outputDir: string,
): Promise<string> {
  const outputPath = join(outputDir, "text.jsonl");
  await rm(outputPath, { force: true });
  function* records() {
    for (const page of result.pages) {
      yield {
        page_number: page.pageNumber,
        text: page.text,
        char_count: page.charCount,
        is_ocr_candidate: page.isOcrCandidate,
      };
    }
  }
  await writeJsonLinesBounded(outputPath, records(), MAX_EXTRACTED_DOCUMENT_BYTES * 2, "Extraction JSONL");
  return outputPath;
}
