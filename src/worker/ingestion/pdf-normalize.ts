/**
 * PDF validation and normalization.
 *
 * Validates that a file is a plausible PDF and normalizes it using qpdf
 * or Ghostscript when available. Falls back gracefully when system tools
 * are not installed.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

/** PDF magic bytes: %PDF- */
const PDF_MAGIC = Buffer.from("%PDF-");

export type NormalizeResult = Readonly<{
  normalizedPath: string;
  method: "qpdf" | "ghostscript" | "none";
  wasRepaired: boolean;
}>;

/**
 * Checks that a buffer starts with the %PDF- magic bytes.
 */
export function isValidPdf(data: Buffer): boolean {
  return data.length >= 5 && data.subarray(0, 5).equals(PDF_MAGIC);
}

/**
 * Checks if a given system command is available on PATH.
 */
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFile("which", [cmd]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes a PDF file for reliable text extraction.
 *
 * Tries qpdf first (fast, lossless), then Ghostscript (re-renders pages),
 * then returns the original path if no tools are available.
 *
 * @param inputPath Absolute path to the original PDF
 * @param outputDir Directory to write the normalized PDF into
 */
export async function normalizePdf(
  inputPath: string,
  outputDir: string,
): Promise<NormalizeResult> {
  await mkdir(outputDir, { recursive: true });

  const outputPath = join(outputDir, "normalized.pdf");

  // Try qpdf first — fast, preserves structure
  if (await commandExists("qpdf")) {
    try {
      await execFile("qpdf", [
        "--linearize",       // optimize for web/random access
        "--qdf",             // normalize streams for downstream tools
        "--no-warn",
        inputPath,
        outputPath,
      ]);
      return { normalizedPath: outputPath, method: "qpdf", wasRepaired: false };
    } catch {
      // qpdf failed — try more aggressive recovery options
      try {
        await execFile("qpdf", [
          "--normalize",         // normalize content streams
          "--suppress-recovery", // bypass qpdf's own recovery to force output
          "--no-warn",
          inputPath,
          outputPath,
        ]);
        return { normalizedPath: outputPath, method: "qpdf", wasRepaired: true };
      } catch {
        // qpdf can't handle it, fall through to ghostscript
      }
    }
  }

  // Try Ghostscript — re-renders pages, strongest normalization
  if (await commandExists("gs")) {
    try {
      await execFile("gs", [
        "-dNOPAUSE",
        "-dBATCH",
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.7",
        "-dPDFSETTINGS=/default",
        "-dCompressFonts=true",
        "-dCompressPages=true",
        `-sOutputFile=${outputPath}`,
        inputPath,
      ]);
      return { normalizedPath: outputPath, method: "ghostscript", wasRepaired: true };
    } catch {
      // Ghostscript also failed
    }
  }

  // No tools available or all failed — copy original as-is
  const data = await readFile(inputPath);
  await writeFile(outputPath, data);
  return { normalizedPath: outputPath, method: "none", wasRepaired: false };
}

/**
 * Returns the number of pages in a PDF using pdfinfo (poppler-utils).
 * Returns null if pdfinfo is not available or fails.
 */
export async function getPdfPageCount(pdfPath: string): Promise<number | null> {
  try {
    const { stdout } = await execFile("pdfinfo", [pdfPath]);
    const match = stdout.match(/Pages:\s+(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}
