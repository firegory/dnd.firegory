/**
 * Tests for PDF normalization module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_EXTRACTED_DOCUMENT_BYTES, MAX_EXTRACTED_PAGE_BYTES, MAX_PDF_INPUT_BYTES } from "../../src/server/ingestion/limits.ts";
import { computeChecksum } from "../../src/server/ingestion/paths.ts";
import { extractTextFromPdf } from "../../src/worker/ingestion/pdf-extract.ts";
import { createImmutablePdfSnapshot, type ImmutablePdfSnapshot } from "../../src/worker/ingestion/file-safety.ts";
import { getPdfPageCount, isValidPdf } from "../../src/worker/ingestion/pdf-normalize.ts";

describe("isValidPdf", () => {
  it("should return true for valid PDF magic bytes", () => {
    const pdf = Buffer.from("%PDF-1.7 rest of file content here");
    assert.equal(isValidPdf(pdf), true);
  });

  it("should return true for PDF with version 2.0", () => {
    const pdf = Buffer.from("%PDF-2.0 some content");
    assert.equal(isValidPdf(pdf), true);
  });

  it("should return false for empty buffer", () => {
    assert.equal(isValidPdf(Buffer.alloc(0)), false);
  });

  it("should return false for non-PDF content", () => {
    assert.equal(isValidPdf(Buffer.from("<html>")), false);
    assert.equal(isValidPdf(Buffer.from("Hello world")), false);
    assert.equal(isValidPdf(Buffer.from("PK")), false); // ZIP
  });

  it("should return false for short buffers", () => {
    assert.equal(isValidPdf(Buffer.from("%PDF")), false); // 4 bytes, need 5
  });

  it("should return false for PDF magic not at start", () => {
    const data = Buffer.from("  %PDF-1.7");
    assert.equal(isValidPdf(data), false);
  });
});

it("stats and rejects an oversized original before allocating its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-input-limit-"));
  const path = join(root, "large.pdf");
  try {
    await writeFile(path, "%PDF-");
    await truncate(path, MAX_PDF_INPUT_BYTES + 1);
    await assert.rejects(createImmutablePdfSnapshot(path), /Original PDF exceeds size limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("bounds pdfinfo stdout, runtime, and child termination", async () => {
  let options: Record<string, unknown> | undefined;
  const pages = await getPdfPageCount("input.pdf", (async (_command, _args, received) => {
    options = received;
    return { stdout: "Pages: 12\n", stderr: "" };
  }) as never);
  assert.equal(pages, 12);
  assert.deepEqual(options, { timeout: 30_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
});

it("bounds pdftotext output before reading and removes oversized page files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-page-limit-"));
  let options: Record<string, unknown> | undefined;
  try {
    const result = await extractTextFromPdf("input.pdf", root, {
      isCommandAvailable: async () => true,
      getPdfPageCount: async () => 1,
      execFile: async (_command, args, received) => {
        options = received;
        const output = args.at(-1)!;
        await writeFile(output, "text");
        await truncate(output, MAX_EXTRACTED_PAGE_BYTES + 1);
      },
    });
    assert.equal(result.pages[0].text, "");
    assert.equal(result.pages[0].isOcrCandidate, true);
    assert.deepEqual(options, { timeout: 30_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
    await assert.rejects(access(join(root, "page-1.txt")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects symlinked PDF inputs with O_NOFOLLOW", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-symlink-"));
  try {
    const target = join(root, "target.pdf");
    const link = join(root, "input.pdf");
    await writeFile(target, "%PDF-1.7 target");
    await symlink(target, link);
    await assert.rejects(createImmutablePdfSnapshot(link), /ELOOP|symbolic link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("hashes and copies the immutable snapshot from the same stable descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-snapshot-"));
  const input = join(root, "input.pdf");
  const data = Buffer.from("%PDF-1.7 stable descriptor snapshot");
  await writeFile(input, data);
  let snapshot: ImmutablePdfSnapshot | undefined;
  try {
    snapshot = await createImmutablePdfSnapshot(input);
    assert.equal(snapshot.size, data.length);
    assert.equal(snapshot.checksumSha256, computeChecksum(data));
    assert.deepEqual(await readFile(snapshot.path), data);
  } finally {
    await snapshot?.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

it("rejects source path swaps after opening the stable descriptor", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-swap-"));
  const input = join(root, "input.pdf");
  const moved = join(root, "moved.pdf");
  try {
    await writeFile(input, "%PDF-1.7 original descriptor contents");
    await assert.rejects(createImmutablePdfSnapshot(input, {
      afterOpen: async () => {
        await rename(input, moved);
        await writeFile(input, "%PDF-1.7 replacement at same path");
      },
    }), /changed while creating immutable snapshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("enforces the aggregate extracted document cap across individually valid pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "pdf-document-cap-"));
  const page = Buffer.alloc(Math.floor(MAX_EXTRACTED_DOCUMENT_BYTES / 9), 65);
  try {
    await assert.rejects(extractTextFromPdf("input.pdf", root, {
      isCommandAvailable: async () => true,
      getPdfPageCount: async () => 10,
      execFile: async (_command, args) => writeFile(args.at(-1)!, page),
    }), /Extracted document exceeds size limit/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
