/**
 * OCR fallback for pages with missing or low-quality text.
 *
 * Uses ocrmypdf with Tesseract (eng + rus) to OCR pages that the text
 * extraction step flagged as needing OCR. Produces an OCR'd PDF and
 * re-extracts text from it.
 */

import { chmod, copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkTesseractLanguages, isCommandAvailable } from "./dependencies.ts";
import { assertBoundedFile, readBoundedUtf8 } from "./file-safety.ts";
import { runMonitoredTool, ToolExecutionError } from "./tool-runner.ts";
import {
  MAX_EXTRACTED_PAGE_BYTES,
  MAX_OCR_OUTPUT_BYTES,
  MAX_OCR_WORKSPACE_BYTES,
  MAX_PDF_INPUT_BYTES,
  OCR_TOOL_TIMEOUT_MS,
  TOOL_STDIO_MAX_BYTES,
} from "../../server/ingestion/limits.ts";

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

type OcrDependencies = Readonly<{
  getOcrAvailability: typeof getOcrAvailability;
  runMonitoredTool: typeof runMonitoredTool;
  createWorkspace: () => Promise<string>;
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
  overrides: Partial<OcrDependencies> = {},
): Promise<OcrResult> {
  const dependencies: OcrDependencies = {
    getOcrAvailability,
    runMonitoredTool,
    createWorkspace: () => mkdtemp(join(tmpdir(), "dnd-ocr-")),
    ...overrides,
  };
  await mkdir(outputDir, { recursive: true });

  if (pagesNeedingOcr.length === 0) {
    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: 0,
      errors: [],
    };
  }

  const availability = await dependencies.getOcrAvailability();
  if (!availability.available) {
    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors: [availability.reason ?? "OCR runtime is unavailable"],
    };
  }

  const workspace = await dependencies.createWorkspace();
  await chmod(workspace, 0o700);
  const privateOcrPath = join(workspace, "ocr.pdf");
  const privateSidecarPath = join(workspace, "ocr-sidecar.txt");
  const ocrPdfPath = join(outputDir, "ocr.pdf");
  const errors: string[] = [];

  try {
    await assertBoundedFile(inputPdfPath, MAX_PDF_INPUT_BYTES, "OCR input PDF");
    // Build pages-to-OCR argument
    // ocrmypdf --pages takes page ranges like "1,3,5" or "1-5"
    const pageRanges = pagesNeedingOcr.map(String).join(",");

    await dependencies.runMonitoredTool("ocrmypdf", buildOcrArguments(
      inputPdfPath,
      privateOcrPath,
      privateSidecarPath,
      pageRanges,
    ), {
      timeoutMs: OCR_TOOL_TIMEOUT_MS,
      maxStdoutBytes: TOOL_STDIO_MAX_BYTES,
      maxOutputBytes: MAX_OCR_WORKSPACE_BYTES,
      monitorPaths: [workspace],
      cwd: workspace,
      env: { ...process.env, TMPDIR: workspace },
    });

    await assertBoundedFile(privateOcrPath, MAX_OCR_OUTPUT_BYTES, "OCR output PDF");
    await rm(ocrPdfPath, { force: true });
    await copyFile(privateOcrPath, ocrPdfPath);
    await chmod(ocrPdfPath, 0o600);
    return {
      ocrPdfPath,
      ocredPages: pagesNeedingOcr.length,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  } catch (err) {
    errors.push(sanitizeOcrError(err));
    await rm(ocrPdfPath, { force: true }).catch(() => undefined);

    return {
      ocrPdfPath: null,
      ocredPages: 0,
      totalRequested: pagesNeedingOcr.length,
      errors,
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
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
  if (error instanceof ToolExecutionError && error.reason === "timeout") return "OCR command timed out";
  if (error instanceof ToolExecutionError && error.reason === "output-limit") return "OCR workspace exceeded size limit";
  if (error instanceof ToolExecutionError && error.reason === "stdout-limit") return "OCR command output exceeded size limit";
  if (error instanceof ToolExecutionError && error.reason === "exit") return `OCR command failed with code ${error.exitCode ?? "unknown"}`;
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
