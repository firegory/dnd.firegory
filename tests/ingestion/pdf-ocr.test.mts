import assert from "node:assert/strict";
import test from "node:test";

import { buildOcrArguments } from "../../src/worker/ingestion/pdf-ocr.ts";

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
});
