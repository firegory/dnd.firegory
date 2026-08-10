import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  MAX_PREVIEW_PAGE,
  PREVIEW_WIDTH_PX,
  CitationPreviewError,
  CitationPreviewInputError,
  citationPreviewCachePath,
  citationPreviewHref,
  isValidCitationPreviewPng,
  parseCitationPreviewRequest,
  readCitationPreviewPng,
  readOrRenderCitationPreviewPng,
  renderPdfPageToPng,
} from "../../src/server/citations/preview.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";
const validPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

test("parseCitationPreviewRequest accepts source, file, and page", () => {
  const input = parseCitationPreviewRequest(
    new URL(`https://example.test/api/citations/preview?sourceId=${sourceId}&fileId=${fileId}&page=42`),
  );

  assert.deepEqual(input, { sourceId, fileId, page: 42 });
});

test("citation links prefer cropped chunks and retain an authorized page fallback", () => {
  assert.equal(
    citationPreviewHref({ chunkId: "chunk", sourceId, fileId, page: 42 }),
    `/api/citations/preview?chunkId=chunk&sourceId=${sourceId}&fileId=${fileId}&page=42`,
  );
  assert.equal(
    citationPreviewHref({ chunkId: null, sourceId, fileId, page: 42 }),
    `/api/citations/preview?sourceId=${sourceId}&fileId=${fileId}&page=42`,
  );
  assert.equal(citationPreviewHref({ chunkId: null, sourceId, fileId, page: null }), null);
});

test("parseCitationPreviewRequest rejects invalid identifiers and page bounds", () => {
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=nope&fileId=${fileId}&page=1`)),
    CitationPreviewInputError,
  );
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=${sourceId}&fileId=${fileId}&page=0`)),
    CitationPreviewInputError,
  );
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=${sourceId}&fileId=${fileId}&page=${MAX_PREVIEW_PAGE + 1}`)),
    CitationPreviewInputError,
  );
});

test("citationPreviewCachePath uses processed artifacts and page-level cache naming", () => {
  assert.equal(
    citationPreviewCachePath({ sourceId, fileId, page: 7, artifactsRoot: "/tmp/artifacts" }),
    `/tmp/artifacts/previews/page-7-w${PREVIEW_WIDTH_PX}.png`,
  );
});

test("page renderer uses argument-safe tools and atomically returns PNG bytes", async () => {
  const fixture = await rendererFixture();
  const originalPath = process.env.PATH;
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
  process.env.STORAGE_ROOT = fixture.root;
  try {
    const pdfPath = join(fixture.root, "rules;touch injected.pdf");
    const outputPath = join(fixture.root, "cache", "page.png");
    await writeFile(pdfPath, "%PDF-1.4\n");
    await renderPdfPageToPng({ pdfPath, outputPath, page: 1 });
    const image = await readFile(outputPath);
    assert.deepEqual([...image.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(image.readUInt32BE(16), 1);
    assert.equal(image.readUInt32BE(20), 1);
    assert.equal((await readdir(join(fixture.root, "cache"))).join(","), "page.png");
    await assert.rejects(() => renderPdfPageToPng({ pdfPath, outputPath, page: 2 }), (error: unknown) => (
      error instanceof CitationPreviewError && error.code === "page_not_found"
    ));
  } finally {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("page renderer reports a missing production tool without leaking its PDF path", async () => {
  const root = await mkdtemp(join(tmpdir(), "citation-preview-missing-"));
  const pdfPath = join(root, "secret.pdf");
  await writeFile(pdfPath, "%PDF-1.4\n");
  const originalPath = process.env.PATH;
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.PATH = root;
  process.env.STORAGE_ROOT = root;
  try {
    await assert.rejects(
      () => renderPdfPageToPng({ pdfPath, outputPath: join(root, "preview.png"), page: 1 }),
      (error: unknown) => {
        assert.ok(error instanceof CitationPreviewError);
        assert.equal(error.code, "renderer_unavailable");
        assert.doesNotMatch(error.message, /secret\.pdf/);
        return true;
      },
    );
  } finally {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("page renderer kills timed-out tools and removes temporary output", async () => {
  const fixture = await rendererFixture("while :; do :; done");
  const originalPath = process.env.PATH;
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
  process.env.STORAGE_ROOT = fixture.root;
  try {
    const pdfPath = join(fixture.root, "rules.pdf");
    const outputPath = join(fixture.root, "cache", "page.png");
    await writeFile(pdfPath, "%PDF-1.4\n");
    await assert.rejects(
      () => renderPdfPageToPng({ pdfPath, outputPath, page: 1, renderTimeoutMs: 50 }),
      (error: unknown) => error instanceof CitationPreviewError && error.code === "render_timeout",
    );
    assert.deepEqual(await readdir(join(fixture.root, "cache")), []);
  } finally {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("cache reads require a complete CRC-valid PNG and remove corrupt entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "citation-preview-cache-"));
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = root;
  try {
    const path = join(root, "processed", "preview.png");
    await mkdir(join(root, "processed"));
    await writeFile(path, validPng);
    assert.equal(isValidCitationPreviewPng(validPng), true);
    assert.deepEqual(await readCitationPreviewPng(path), validPng);

    for (const invalid of [
      validPng.subarray(0, validPng.length - 1),
      Buffer.from(validPng).fill(0, 45, 46),
      validPng.subarray(0, 33),
    ]) {
      await writeFile(path, invalid);
      await assert.rejects(() => readCitationPreviewPng(path), previewError("output_invalid"));
      await assert.rejects(() => readFile(path), { code: "ENOENT" });
    }
  } finally {
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("PNG decode validation rejects CRC-valid malformed compressed data and scanlines", () => {
  const malformed = [
    syntheticPng({ idat: Buffer.from("not-a-zlib-stream") }),
    syntheticPng({ scanlines: Buffer.alloc(1024 * 1024) }),
    syntheticPng({ bitDepth: 16 }),
    syntheticPng({ colorType: 3 }),
    syntheticPng({ compression: 1 }),
    syntheticPng({ filterMethod: 1 }),
    syntheticPng({ interlace: 1 }),
    syntheticPng({ scanlines: Buffer.from([0, 0]) }),
    syntheticPng({ scanlines: Buffer.from([5, 0, 0]) }),
    syntheticPng({ scanlines: Buffer.from([0, 0, 0, 0]) }),
    Buffer.concat([syntheticPng(), pngChunk("tEXt", Buffer.from("trailing"))]),
    pngWithSeparatedIdatChunks(),
  ];
  for (const image of malformed) assert.equal(isValidCitationPreviewPng(image), false);
});

test("PNG decode validation accepts Poppler-compatible non-interlaced 8-bit color formats", () => {
  for (const [colorType, channels] of [[0, 1], [2, 3], [4, 2], [6, 4]] as const) {
    assert.equal(isValidCitationPreviewPng(syntheticPng({
      colorType,
      scanlines: Buffer.alloc(1 + channels),
    })), true);
  }
});

test("PNG chunk types reject high-bit aliases, unknown critical types, and invalid reserved bits", () => {
  const idatLike = Buffer.from([0xc9, 0x44, 0x41, 0x54]);
  assert.equal(isValidCitationPreviewPng(pngWithChunks({ beforeIdat: [rawPngChunk(idatLike, Buffer.alloc(0))] })), false);
  assert.equal(isValidCitationPreviewPng(pngWithChunks({ beforeIdat: [pngChunk("ABCD", Buffer.alloc(0))] })), false);
  assert.equal(isValidCitationPreviewPng(pngWithChunks({ beforeIdat: [pngChunk("abcD", Buffer.alloc(0))] })), false);
});

test("PNG chunk types allow CRC-valid ancillary chunks in valid order", () => {
  const image = pngWithChunks({
    beforeIdat: [pngChunk("tEXt", Buffer.from("source=poppler"))],
    afterIdat: [pngChunk("tIME", Buffer.from([0x07, 0xe8, 1, 1, 0, 0, 0]))],
  });
  assert.equal(isValidCitationPreviewPng(image), true);
});

test("corrupt canonical cache entries are truncated and rerendered from the canonical source PDF", async () => {
  const fixture = await rendererFixture();
  const originalPath = process.env.PATH;
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
  process.env.STORAGE_ROOT = fixture.root;
  try {
    const sourceDirectory = join(fixture.root, "originals", sourceId);
    const cachePath = join(fixture.root, "processed", sourceId, fileId, "previews", `page-1-w${PREVIEW_WIDTH_PX}.png`);
    await mkdir(sourceDirectory, { recursive: true });
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(join(sourceDirectory, `${fileId}.pdf`), "%PDF-1.4\n");
    await writeFile(cachePath, syntheticPng({ idat: Buffer.from("crc-valid-but-not-zlib") }));

    const image = await readOrRenderCitationPreviewPng({
      sourceId,
      fileId,
      storagePath: join(sourceDirectory, `${fileId}.pdf`),
      artifactsRoot: null,
    }, 1);
    assert.deepEqual(image, validPng);
    assert.deepEqual(await readFile(cachePath), validPng);
  } finally {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("preview files reject escapes, symlinks, nonregular files, option-like paths, and oversized cache entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "citation-preview-paths-"));
  const outside = await mkdtemp(join(tmpdir(), "citation-preview-outside-"));
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.STORAGE_ROOT = root;
  try {
    const cache = join(root, "cache");
    await mkdir(cache);
    const validPath = join(cache, "valid.png");
    await writeFile(validPath, validPng);
    await symlink(validPath, join(cache, "linked.png"));
    await symlink(outside, join(root, "linked-component"));
    await mkdir(join(cache, "directory.png"));
    await writeFile(join(cache, "-option.png"), validPng);
    const oversized = join(cache, "oversized.png");
    await writeFile(oversized, validPng);
    await truncate(oversized, 16 * 1024 * 1024 + 1);

    for (const path of [
      join(outside, "outside.png"),
      join(cache, "linked.png"),
      join(root, "linked-component", "preview.png"),
      join(cache, "directory.png"),
      join(cache, "-option.png"),
      oversized,
    ]) {
      await assert.rejects(() => readCitationPreviewPng(path), previewError("output_invalid"));
    }
  } finally {
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("renderer rejects DB source and cache paths outside the canonical storage root", async () => {
  const fixture = await rendererFixture();
  const outside = await mkdtemp(join(tmpdir(), "citation-preview-render-outside-"));
  const originalPath = process.env.PATH;
  const originalStorageRoot = process.env.STORAGE_ROOT;
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
  process.env.STORAGE_ROOT = fixture.root;
  try {
    const source = join(fixture.root, "source.pdf");
    await writeFile(source, "%PDF-1.4\n");
    await symlink(source, join(fixture.root, "source-link.pdf"));
    await assert.rejects(
      () => renderPdfPageToPng({ pdfPath: join(outside, "source.pdf"), outputPath: join(fixture.root, "preview.png"), page: 1 }),
      previewError("source_file_missing"),
    );
    await assert.rejects(
      () => renderPdfPageToPng({ pdfPath: join(fixture.root, "source-link.pdf"), outputPath: join(fixture.root, "preview.png"), page: 1 }),
      previewError("source_file_missing"),
    );
    await assert.rejects(
      () => renderPdfPageToPng({ pdfPath: source, outputPath: join(outside, "preview.png"), page: 1 }),
      previewError("cache_unwritable"),
    );
  } finally {
    restoreEnvironment("PATH", originalPath);
    restoreEnvironment("STORAGE_ROOT", originalStorageRoot);
    await rm(fixture.root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function rendererFixture(rendererBody = `for last do :; done\nprintf '%s' '${validPng.toString("base64")}' | base64 -d > "$last.png"`): Promise<{ root: string; bin: string }> {
  const root = await mkdtemp(join(tmpdir(), "citation-preview-tools-"));
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeTool(join(bin, "pdfinfo"), 'printf "Pages:          1\\n"');
  await writeTool(join(bin, "pdftoppm"), rendererBody);
  await writeTool(join(bin, "pdftocairo"), rendererBody);
  return { root, bin };
}

async function writeTool(path: string, body: string): Promise<void> {
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
}

function previewError(code: string): (error: unknown) => boolean {
  return (error) => error instanceof CitationPreviewError && error.code === code;
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function syntheticPng(options: Readonly<{
  width?: number;
  height?: number;
  bitDepth?: number;
  colorType?: number;
  compression?: number;
  filterMethod?: number;
  interlace?: number;
  scanlines?: Buffer;
  idat?: Buffer;
}> = {}): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(options.width ?? 1, 0);
  ihdr.writeUInt32BE(options.height ?? 1, 4);
  ihdr[8] = options.bitDepth ?? 8;
  ihdr[9] = options.colorType ?? 4;
  ihdr[10] = options.compression ?? 0;
  ihdr[11] = options.filterMethod ?? 0;
  ihdr[12] = options.interlace ?? 0;
  const idat = options.idat ?? deflateSync(options.scanlines ?? Buffer.from([0, 0, 0]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithSeparatedIdatChunks(): Buffer {
  return pngWithChunks({
    afterIdat: [pngChunk("tEXt", Buffer.from("separator")), pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0])))],
  });
}

function pngChunk(type: string, data: Buffer): Buffer {
  return rawPngChunk(Buffer.from(type, "ascii"), data);
}

function rawPngChunk(type: Buffer, data: Buffer): Buffer {
  assert.equal(type.byteLength, 4);
  const chunk = Buffer.alloc(data.byteLength + 12);
  chunk.writeUInt32BE(data.byteLength, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(testCrc32(chunk, 4, 8 + data.byteLength), 8 + data.byteLength);
  return chunk;
}

function pngWithChunks(options: Readonly<{ beforeIdat?: readonly Buffer[]; afterIdat?: readonly Buffer[] }>): Buffer {
  const base = syntheticPng();
  const idatOffset = 8 + 25;
  const idatEnd = idatOffset + base.readUInt32BE(idatOffset) + 12;
  return Buffer.concat([
    base.subarray(0, idatOffset),
    ...(options.beforeIdat ?? []),
    base.subarray(idatOffset, idatEnd),
    ...(options.afterIdat ?? []),
    base.subarray(idatEnd),
  ]);
}

function testCrc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
