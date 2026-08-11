import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildOcrArguments, ocrExecOptions, ocrPdf, sanitizeOcrError } from "../../src/worker/ingestion/pdf-ocr.ts";
import { runMonitoredTool, ToolExecutionError } from "../../src/worker/ingestion/tool-runner.ts";

test("forced OCR command is page-scoped and uses Russian plus English", () => {
  assert.deepEqual(buildOcrArguments("input.pdf", "output.pdf", "sidecar.txt", "2,7,9"), [
    "--language", "eng+rus",
    "--force-ocr",
    "--deskew",
    "--remove-background",
    "--sidecar", "sidecar.txt",
    "--pages", "2,7,9",
    "--output-type", "pdf",
    "input.pdf",
    "output.pdf",
  ]);
  assert.deepEqual(ocrExecOptions, {
    timeout: 300_000,
    maxBuffer: 1024 * 1024,
    killSignal: "SIGKILL",
  });
});

test("OCR errors retain bounded reason codes without leaking filesystem paths", () => {
  const failure = Object.assign(new Error("Command failed for /secret/uploads/book.pdf"), { code: 6 });
  assert.equal(sanitizeOcrError(failure), "OCR command failed with code 6");
  assert.doesNotMatch(sanitizeOcrError(failure), /secret|book\.pdf/);
  const timeout = Object.assign(new Error("/secret/path"), { killed: true, signal: "SIGKILL" });
  assert.equal(sanitizeOcrError(timeout), "OCR command timed out");
  assert.equal(sanitizeOcrError(new ToolExecutionError("monitor-error")), "OCR workspace monitoring failed");
  assert.equal(
    sanitizeOcrError(new ToolExecutionError("output-limit", null, "OCR output PDF")),
    "OCR output PDF exceeded size limit",
  );
});

test("fake OCR survives repeated workspace polls with an outside origin symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-symlink-"));
  const input = join(root, "input.pdf");
  const outputDir = join(root, "output");
  const workspace = join(root, "private-workspace");
  const outside = join(root, "outside.bin");
  const script = join(root, "fake-ocr.cjs");
  await writeFile(input, "%PDF-1.7 input");
  await mkdir(workspace);
  await writeFile(outside, "");
  await truncate(outside, 3 * 1024 * 1024 * 1024);
  await writeFile(script, `
const fs = require("node:fs");
const path = require("node:path");
const [outside, ...ocrArgs] = process.argv.slice(2);
fs.symlinkSync(outside, path.join(process.cwd(), "origin"));
setTimeout(() => fs.writeFileSync(ocrArgs.at(-1), "%PDF-1.7 fake OCR"), 125);
`);
  try {
    const started = Date.now();
    const result = await ocrPdf(input, [1], outputDir, {
      getOcrAvailability: async () => ({ available: true, reason: null }),
      createWorkspace: async () => workspace,
      runMonitoredTool: (_command, args, options) => runMonitoredTool(
        process.execPath,
        [script, outside, ...args],
        { ...options, pollMs: 10 },
      ),
    });
    assert.ok(Date.now() - started >= 100);
    assert.equal(result.ocrPdfPath, join(outputDir, "ocr.pdf"));
    assert.deepEqual(result.errors, []);
    assert.equal((await stat(outside)).size, 3 * 1024 * 1024 * 1024);
    await assert.rejects(access(workspace), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OCR always recursively removes its private workspace after monitored failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "ocr-cleanup-"));
  const input = join(root, "input.pdf");
  const outputDir = join(root, "output");
  const workspace = join(root, "private-workspace");
  await writeFile(input, "%PDF-1.7 input");
  await mkdir(workspace);
  try {
    const result = await ocrPdf(input, [1], outputDir, {
      getOcrAvailability: async () => ({ available: true, reason: null }),
      createWorkspace: async () => workspace,
      runMonitoredTool: async (_command, _args, options) => {
        await mkdir(join(options.cwd!, "nested"));
        await writeFile(join(options.cwd!, "nested", "partial.bin"), "partial");
        throw new ToolExecutionError("output-limit");
      },
    });
    assert.equal(result.ocrPdfPath, null);
    assert.deepEqual(result.errors, ["OCR workspace exceeded size limit"]);
    await assert.rejects(access(workspace), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
