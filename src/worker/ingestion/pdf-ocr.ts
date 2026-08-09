/**
 * OCR fallback for pages with missing or low-quality text.
 *
 * Uses ocrmypdf with Tesseract (eng + rus) to OCR pages that the text
 * extraction step flagged as needing OCR. Produces an OCR'd PDF and
 * re-extracts text from it.
 */

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { checkTesseractLanguages, isCommandAvailable } from "./dependencies.ts";
import { assertBoundedFile, readBoundedUtf8 } from "./file-safety.ts";
import {
  MAX_EXTRACTED_PAGE_BYTES,
  MAX_OCR_OUTPUT_BYTES,
  MAX_PDF_INPUT_BYTES,
  OCR_TOOL_TIMEOUT_MS,
  TOOL_STDIO_MAX_BYTES,
} from "../../server/ingestion/limits.ts";

const execFile = promisify(execFileCb);
export const ocrExecOptions = {
  timeout: OCR_TOOL_TIMEOUT_MS,
  maxBuffer: TOOL_STDIO_MAX_BYTES,
  killSignal: "SIGKILL" as const,
};

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
  return (await getOcrAvailability()).available;
}

export async function getOcrAvailability(): Promise<Readonly<{
  available: boolean;
  reason: string | null;
}>> {
  if (!(await isCommandAvailable("ocrmypdf"))) {
    return { available: false, reason: "OCRmyPDF executable is unavailable" };
  }
  const languages = await checkTesseractLanguages();
  return { available: languages.available, reason: languages.error };
}

/**
 * Runs OCR on a PDF file for pages that need it.
 *
 * Uses ocrmypdf with:
 * - English + Russian language packs
 * - --pages to limit work to selected pages
 * - --force-ocr to replace broken text layers on those pages
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

  const availability = await getOcrAvailability();
  if (!availability.available) {
    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors: [availability.reason ?? "OCR runtime is unavailable"],
    };
  }

  const ocrPdfPath = join(outputDir, "ocr.pdf");
  const sidecarPath = join(outputDir, "ocr-sidecar.txt");
  const errors: string[] = [];

  try {
    await assertBoundedFile(inputPdfPath, MAX_PDF_INPUT_BYTES, "OCR input PDF");
    // Build pages-to-OCR argument
    // ocrmypdf --pages takes page ranges like "1,3,5" or "1-5"
    const pageRanges = pagesNeedingOcr.map(String).join(",");

    await execFile("ocrmypdf", buildOcrArguments(
      inputPdfPath,
      ocrPdfPath,
      sidecarPath,
      pageRanges,
    ), ocrExecOptions);

    await assertBoundedFile(ocrPdfPath, MAX_OCR_OUTPUT_BYTES, "OCR output PDF");
    return {
      ocrPdfPath,
      ocredPages: pagesNeedingOcr.length,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  } catch (err) {
    errors.push(sanitizeOcrError(err));
    await Promise.allSettled([
      rm(ocrPdfPath, { force: true }),
      rm(sidecarPath, { force: true }),
    ]);

    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  }
}

export function buildOcrArguments(
  inputPdfPath: string,
  outputPdfPath: string,
  sidecarPath: string,
  pageRanges: string,
): readonly string[] {
  return [
    "--language", "eng+rus",
    "--force-ocr",
    "--deskew",
    "--remove-background",
    "--sidecar", sidecarPath,
    "--pages", pageRanges,
    "--output-type", "pdf",
    inputPdfPath,
    outputPdfPath,
  ];
}

/**
 * Reads the OCR sidecar text file produced by ocrmypdf --sidecar.
 * Returns an array of text blocks, one per page (separated by form feed).
 */
export async function readOcrSidecar(sidecarPath: string): Promise<string[]> {
  try {
    const content = await readBoundedUtf8(sidecarPath, MAX_EXTRACTED_PAGE_BYTES, "OCR sidecar");
    // ocrmypdf sidecar uses \f (form feed) as page separator
    return content.split("\f").map((p) => p.trim());
  } catch {
    return [];
  }
}

export function sanitizeOcrError(error: unknown): string {
  if (error instanceof Error && "killed" in error && error.killed) return "OCR command timed out";
  if (error instanceof Error && "code" in error) {
    const code = typeof error.code === "number" || typeof error.code === "string"
      ? String(error.code).replace(/[^A-Za-z0-9_-]/g, "")
      : "unknown";
    return `OCR command failed with code ${code}`;
  }
  if (error instanceof Error && /size limit/i.test(error.message)) return error.message;
  return "OCR command failed";
}
