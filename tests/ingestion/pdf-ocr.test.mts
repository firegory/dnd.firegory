import assert from "node:assert/strict";
import test from "node:test";

import { buildOcrArguments, ocrExecOptions, sanitizeOcrError } from "../../src/worker/ingestion/pdf-ocr.ts";

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
});
