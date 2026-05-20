import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

export type PdfToolDependency = Readonly<{
  command: string;
  packageName: string;
  purpose: string;
  required: boolean;
}>;

export type PdfDependencyStatus = PdfToolDependency & Readonly<{
  available: boolean;
}>;

export const PDF_TOOL_DEPENDENCIES: readonly PdfToolDependency[] = [
  {
    command: "pdfinfo",
    packageName: "poppler-utils",
    purpose: "detect PDF page count before per-page text extraction",
    required: true,
  },
  {
    command: "pdftotext",
    packageName: "poppler-utils",
    purpose: "extract text from PDF pages",
    required: true,
  },
  {
    command: "qpdf",
    packageName: "qpdf",
    purpose: "normalize and repair PDFs before extraction",
    required: false,
  },
  {
    command: "gs",
    packageName: "ghostscript",
    purpose: "fallback PDF normalization via Ghostscript",
    required: false,
  },
  {
    command: "ocrmypdf",
    packageName: "ocrmypdf",
    purpose: "OCR scanned or low-text pages",
    required: false,
  },
  {
    command: "tesseract",
    packageName: "tesseract-ocr",
    purpose: "OCR engine used by ocrmypdf",
    required: false,
  },
];

export function pdfDependencyInstallCommand(): string {
  return "sudo apt-get update && sudo apt-get install -y poppler-utils qpdf ghostscript ocrmypdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus";
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  const paths = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean);

  for (const directory of paths) {
    try {
      await access(join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Try the next PATH entry.
    }
  }

  return false;
}

export async function checkPdfToolDependencies(): Promise<readonly PdfDependencyStatus[]> {
  return Promise.all(
    PDF_TOOL_DEPENDENCIES.map(async (dependency) => ({
      ...dependency,
      available: await isCommandAvailable(dependency.command),
    })),
  );
}

export function formatPdfDependencyReport(statuses: readonly PdfDependencyStatus[]): string | null {
  const missingRequired = statuses.filter((dependency) => dependency.required && !dependency.available);
  const missingOptional = statuses.filter((dependency) => !dependency.required && !dependency.available);

  if (missingRequired.length === 0 && missingOptional.length === 0) {
    return null;
  }

  const lines = ["PDF ingestion worker system dependency check:"];

  if (missingRequired.length > 0) {
    lines.push(
      `Missing required tools: ${missingRequired.map((dependency) => dependency.command).join(", ")}.`,
      "Jobs will fail before PDF text extraction until these are installed.",
    );
  }

  if (missingOptional.length > 0) {
    lines.push(
      `Missing optional full-pipeline tools: ${missingOptional.map((dependency) => dependency.command).join(", ")}.`,
      "The worker can continue, but PDF normalization/OCR quality may be degraded.",
    );
  }

  lines.push(
    `Install on Debian/Ubuntu with: ${pdfDependencyInstallCommand()}`,
  );

  return lines.join("\n");
}
