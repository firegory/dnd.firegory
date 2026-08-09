/**
 * OCR fallback for pages with missing or low-quality text.
 *
 * Uses ocrmypdf with Tesseract (eng + rus) to OCR pages that the text
 * extraction step flagged as needing OCR. Produces an OCR'd PDF and
 * re-extracts text from it.
 */

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

import { isCommandAvailable } from "./dependencies.ts";

const execFile = promisify(execFileCb);
const OCR_TIMEOUT_MS = 300_000;
const OCR_MAX_PDF_BYTES = 512 * 1024 * 1024;
const OCR_MAX_OUTPUT_BYTES = 1024 * 1024;

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
  const sidecarPath = join(outputDir, "ocr-sidecar.txt");
  const errors: string[] = [];

  try {
    const inputSize = (await stat(inputPdfPath)).size;
    if (inputSize > OCR_MAX_PDF_BYTES) {
      throw new Error(`PDF exceeds OCR size limit of ${OCR_MAX_PDF_BYTES} bytes`);
    }
    // Build pages-to-OCR argument
    // ocrmypdf --pages takes page ranges like "1,3,5" or "1-5"
    const pageRanges = pagesNeedingOcr.map(String).join(",");

    await execFile("ocrmypdf", buildOcrArguments(
      inputPdfPath,
      ocrPdfPath,
      sidecarPath,
      pageRanges,
    ), {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: OCR_MAX_OUTPUT_BYTES,
      killSignal: "SIGKILL",
    });

    return {
      ocrPdfPath,
      ocredPages: pagesNeedingOcr.length,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`ocrmypdf failed: ${message}`);
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
    const content = await readFile(sidecarPath, "utf-8");
    // ocrmypdf sidecar uses \f (form feed) as page separator
    return content.split("\f").map((p) => p.trim());
  } catch {
    return [];
  }
}
