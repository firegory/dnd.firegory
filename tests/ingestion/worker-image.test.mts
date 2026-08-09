import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("production worker image contains English and Russian OCR language data", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");
  const marker = dockerfile.indexOf("FROM production-base AS worker-production");
  assert.notEqual(marker, -1);
  const worker = dockerfile.slice(marker);
  assert.match(worker, /tesseract-ocr-eng/);
  assert.match(worker, /tesseract-ocr-rus/);
});
