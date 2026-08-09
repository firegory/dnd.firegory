import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_PREVIEW_PAGE,
  PREVIEW_WIDTH_PX,
  CitationPreviewError,
  CitationPreviewInputError,
  citationPreviewCachePath,
  citationPreviewHref,
  parseCitationPreviewRequest,
  renderPdfPageToPng,
} from "../../src/server/citations/preview.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";

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
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
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
    process.env.PATH = originalPath;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("page renderer reports a missing production tool without leaking its PDF path", async () => {
  const root = await mkdtemp(join(tmpdir(), "citation-preview-missing-"));
  const pdfPath = join(root, "secret.pdf");
  await writeFile(pdfPath, "%PDF-1.4\n");
  const originalPath = process.env.PATH;
  process.env.PATH = root;
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
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("page renderer kills timed-out tools and removes temporary output", async () => {
  const fixture = await rendererFixture("while :; do :; done");
  const originalPath = process.env.PATH;
  process.env.PATH = `${fixture.bin}:${originalPath ?? ""}`;
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
    process.env.PATH = originalPath;
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function rendererFixture(rendererBody = 'for last do :; done\nprintf "\\211PNG\\r\\n\\032\\n\\000\\000\\000\\rIHDR\\000\\000\\000\\001\\000\\000\\000\\001" > "$last.png"'): Promise<{ root: string; bin: string }> {
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
