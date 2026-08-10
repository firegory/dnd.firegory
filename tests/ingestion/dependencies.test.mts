import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatPdfDependencyReport,
  checkTesseractLanguages,
  parseTesseractLanguages,
  pdfDependencyInstallCommand,
  type PdfDependencyStatus,
} from "../../src/worker/ingestion/dependencies.ts";

const baseStatus = (overrides: Partial<PdfDependencyStatus>): PdfDependencyStatus => ({
  command: "pdfinfo",
  packageName: "poppler-utils",
  purpose: "test purpose",
  required: true,
  available: true,
  ...overrides,
});

describe("PDF worker dependency reporting", () => {
  it("returns null when all dependencies are available", () => {
    const report = formatPdfDependencyReport([
      baseStatus({ command: "pdfinfo", required: true, available: true }),
      baseStatus({ command: "pdftotext", required: true, available: true }),
      baseStatus({ command: "ocrmypdf", required: false, available: true }),
    ]);

    assert.equal(report, null);
  });

  it("explains that missing required tools block text extraction", () => {
    const report = formatPdfDependencyReport([
      baseStatus({ command: "pdfinfo", required: true, available: false }),
      baseStatus({ command: "pdftotext", required: true, available: false }),
      baseStatus({ command: "qpdf", required: false, available: true }),
    ]);

    assert.ok(report);
    assert.match(report, /Missing required tools: pdfinfo, pdftotext/);
    assert.match(report, /Jobs will fail before PDF text extraction/);
    assert.match(report, /poppler-utils/);
  });

  it("reports missing optional tools as degraded full-pipeline support", () => {
    const report = formatPdfDependencyReport([
      baseStatus({ command: "pdfinfo", required: true, available: true }),
      baseStatus({ command: "pdftotext", required: true, available: true }),
      baseStatus({ command: "ocrmypdf", required: false, available: false }),
      baseStatus({ command: "tesseract", required: false, available: false }),
    ]);

    assert.ok(report);
    assert.match(report, /Missing optional full-pipeline tools: ocrmypdf, tesseract/);
    assert.match(report, /normalization\/OCR quality may be degraded/);
  });

  it("documents the Debian\/Ubuntu install command", () => {
    assert.equal(
      pdfDependencyInstallCommand(),
      "sudo apt-get update && sudo apt-get install -y poppler-utils qpdf ghostscript ocrmypdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-rus",
    );
  });

  it("parses bounded Tesseract language output and requires both packs", () => {
    assert.deepEqual(
      parseTesseractLanguages("List of available languages in /usr/share/tesseract-ocr/:\neng\nrus\nosd\n"),
      ["eng", "rus", "osd"],
    );
    assert.equal(parseTesseractLanguages("eng\nosd\n").includes("rus"), false);
  });

  it("checks Tesseract language data with bounded execution", async () => {
    let options: Record<string, unknown> | undefined;
    const status = await checkTesseractLanguages({
      commandAvailable: async () => true,
      run: (async (_command: string, _args: string[], received: Record<string, unknown>) => {
        options = received;
        return { stdout: "eng\nrus\n", stderr: "" };
      }) as never,
    });
    assert.equal(status.available, true);
    assert.deepEqual(options, { timeout: 30_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });

    const missing = await checkTesseractLanguages({
      commandAvailable: async () => true,
      run: (async () => ({ stdout: "eng\n", stderr: "" })) as never,
    });
    assert.deepEqual(missing.missing, ["rus"]);
    assert.equal(missing.error, "Missing Tesseract language data: rus");
  });
});
