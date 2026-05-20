/**
 * OCR fallback for pages with missing or low-quality text.
 *
 * Uses ocrmypdf with Tesseract (eng + rus) to OCR pages that the text
 * extraction step flagged as needing OCR. Produces an OCR'd PDF and
 * re-extracts text from it.
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { isCommandAvailable } from "./dependencies.ts";

const execFile = promisify(execFileCb);

export type OcrResult = Readonly<{
  ocrPdfPath: string | null;
  ocredPages: number;
  totalRequested: number;
  errors: readonly string[];
}>;

/**
 * Checks if ocrmypdf is available on the system.
 */
export async function isOcrAvailable(): Promise<boolean> {
  return isCommandAvailable("ocrmypdf");
}

/**
 * Runs OCR on a PDF file for pages that need it.
 *
 * Uses ocrmypdf with:
 * - English + Russian language packs
 * - --skip-text to avoid re-OCRing pages that already have text
 * - --force-ocr for pages flagged as needing OCR
 *
 * @param inputPdfPath Path to the (possibly normalized) PDF
 * @param pagesNeedingOcr Page numbers that need OCR
 * @param outputDir Directory for OCR output
 */
export async function ocrPdf(
  inputPdfPath: string,
  pagesNeedingOcr: readonly number[],
  outputDir: string,
): Promise<OcrResult> {
  await mkdir(outputDir, { recursive: true });

  if (pagesNeedingOcr.length === 0) {
    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: 0,
      errors: [],
    };
  }

  if (!(await isOcrAvailable())) {
    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors: ["ocrmypdf is not installed or not on PATH"],
    };
  }

  const ocrPdfPath = join(outputDir, "ocr.pdf");
  const errors: string[] = [];

  try {
    // Build pages-to-OCR argument
    // ocrmypdf --pages takes page ranges like "1,3,5" or "1-5"
    const pageRanges = pagesNeedingOcr.map(String).join(",");

    await execFile("ocrmypdf", [
      "--language", "eng+rus",
      "--deskew",            // Fix skewed scans
      "--remove-background", // Clean up scanned backgrounds
      "--sidecar", join(outputDir, "ocr-sidecar.txt"), // Extract text alongside
      "--pages", pageRanges,
      "--output-type", "pdf",
      inputPdfPath,
      ocrPdfPath,
    ], { timeout: 300_000 }); // 5 min timeout for large PDFs

    return {
      ocrPdfPath,
      ocredPages: pagesNeedingOcr.length,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`ocrmypdf failed: ${message}`);

    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  }
}

/**
 * Reads the OCR sidecar text file produced by ocrmypdf --sidecar.
 * Returns an array of text blocks, one per page (separated by form feed).
 */
export async function readOcrSidecar(sidecarPath: string): Promise<string[]> {
  try {
    const content = await readFile(sidecarPath, "utf-8");
    // ocrmypdf sidecar uses \f (form feed) as page separator
    return content.split("\f").map((p) => p.trim());
  } catch {
    return [];
  }
}
