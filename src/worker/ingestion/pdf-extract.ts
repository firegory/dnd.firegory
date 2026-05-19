/**
 * PDF text extraction with page mapping.
 *
 * Uses pdftotext (poppler-utils) to extract text from each page.
 * Produces a per-page text map suitable for downstream chunking.
 */

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { getPdfPageCount } from "./pdf-normalize.ts";

const execFile = promisify(execFileCb);

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
): Promise<ExtractionResult> {
  await mkdir(outputDir, { recursive: true });

  const pages = await extractPagesIndividually(pdfPath, outputDir);

  if (pages.length === 0) {
    // Fallback: try extracting the entire file as one page
    const wholeText = await extractWholeFile(pdfPath, outputDir);
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
): Promise<ExtractedPage[]> {
  // First get page count
  const pageCount = await getPdfPageCount(pdfPath);
  if (pageCount === null || pageCount === 0) {
    return [];
  }

  const pages: ExtractedPage[] = [];

  for (let pageNum = 1; pageNum <= pageCount; pageNum++) {
    const pageOutputPath = join(outputDir, `page-${pageNum}.txt`);
    try {
      await execFile("pdftotext", [
        "-enc", "UTF-8",
        "-layout",
        "-f", String(pageNum),
        "-l", String(pageNum),
        pdfPath,
        pageOutputPath,
      ]);
    } catch {
      // pdftotext failed for this page — mark as OCR candidate
      pages.push({
        pageNumber: pageNum,
        text: "",
        charCount: 0,
        isOcrCandidate: true,
      });
      continue;
    }

    const text = await readFile(pageOutputPath, "utf-8").catch(() => "");
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
): Promise<string> {
  const outputPath = join(outputDir, "full-text.txt");
  try {
    await execFile("pdftotext", [
      "-enc", "UTF-8",
      "-layout",
      pdfPath,
      outputPath,
    ]);
    return await readFile(outputPath, "utf-8");
  } catch {
    return "";
  }
}

/**
 * Saves extracted text as JSONL (one JSON object per page).
 */
export async function saveExtractionResults(
  result: ExtractionResult,
  outputDir: string,
): Promise<string> {
  const outputPath = join(outputDir, "text.jsonl");
  const lines = result.pages.map((page) =>
    JSON.stringify({
      page_number: page.pageNumber,
      text: page.text,
      char_count: page.charCount,
      is_ocr_candidate: page.isOcrCandidate,
    }),
  );
  await writeFile(outputPath, lines.join("\n") + "\n");
  return outputPath;
}
