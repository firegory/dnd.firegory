/**
 * Server-side citation PDF preview rendering.
 *
 * The preview flow deliberately renders one requested page to an image and
 * never exposes the original PDF path or a public PDF URL to the client.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink, type FileHandle } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { inflateSync } from "node:zlib";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { artifactsRootPath, getStorageRoot, originalFilePath } from "../ingestion/paths.ts";
import type { ChunkBbox } from "../../worker/ingestion/bbox.ts";

export const MAX_PREVIEW_PAGE = 5000;
export const PREVIEW_WIDTH_PX = 1400;
export const RENDER_TIMEOUT_MS = 30_000;
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;
export const MAX_PREVIEW_DECOMPRESSED_BYTES = 16 * 1024 * 1024;

const PDF_INFO_TIMEOUT_MS = 5_000;
const MAX_CROP_DIMENSION_PX = 2000;
const MAX_PREVIEW_DIMENSION_PX = MAX_CROP_DIMENSION_PX;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = 0x49484452;
const PNG_PLTE = 0x504c5445;
const PNG_IDAT = 0x49444154;
const PNG_IEND = 0x49454e44;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CitationPreviewRequest = Readonly<{
  sourceId: string;
  fileId: string;
  page: number;
}>;

export type CitationPreviewFile = Readonly<{
  sourceId: string;
  fileId: string;
  storagePath: string;
  artifactsRoot: string | null;
}>;

export function citationPreviewHref(input: Readonly<{
  chunkId: string | null;
  sourceId: string | null;
  fileId: string | null;
  page: number | null;
}>): string | null {
  const pageQuery = input.sourceId && input.fileId && input.page
    ? `sourceId=${encodeURIComponent(input.sourceId)}&fileId=${encodeURIComponent(input.fileId)}&page=${input.page}`
    : null;
  if (input.chunkId) {
    return `/api/citations/preview?chunkId=${encodeURIComponent(input.chunkId)}${pageQuery ? `&${pageQuery}` : ""}`;
  }
  return pageQuery ? `/api/citations/preview?${pageQuery}` : null;
}

export function parseCitationPreviewRequest(url: URL): CitationPreviewRequest {
  const sourceId = url.searchParams.get("sourceId")?.trim() ?? "";
  const fileId = url.searchParams.get("fileId")?.trim() ?? "";
  const pageRaw = url.searchParams.get("page")?.trim() ?? "";
  const page = Number(pageRaw);

  if (!UUID_RE.test(sourceId)) {
    throw new CitationPreviewInputError("Invalid sourceId.");
  }
  if (!UUID_RE.test(fileId)) {
    throw new CitationPreviewInputError("Invalid fileId.");
  }
  if (!Number.isInteger(page) || page < 1 || page > MAX_PREVIEW_PAGE) {
    throw new CitationPreviewInputError(`Page must be an integer from 1 to ${MAX_PREVIEW_PAGE}.`);
  }

  return { sourceId, fileId, page };
}

export function parseChunkPreviewRequest(url: URL): { chunkId: string } {
  const chunkId = url.searchParams.get("chunkId")?.trim() ?? "";
  if (!UUID_RE.test(chunkId)) {
    throw new CitationPreviewInputError("Invalid chunkId.");
  }
  return { chunkId };
}

export function citationPreviewCachePath(input: CitationPreviewRequest & { artifactsRoot?: string | null }): string {
  const root = input.artifactsRoot ?? artifactsRootPath(input.sourceId, input.fileId);
  return join(root, "previews", `page-${input.page}-w${PREVIEW_WIDTH_PX}.png`);
}

export async function getAuthorizedCitationPreviewFile(
  user: RetrievalUser,
  input: Pick<CitationPreviewRequest, "sourceId" | "fileId">,
): Promise<CitationPreviewFile | null> {
  const filter = buildRetrievalAuthorizationFilter(user);
  const accessFilter = buildSourceAccessSql(filter);
  const params = [...accessFilter.params, input.sourceId, input.fileId];
  const sourceParam = params.length - 1;
  const fileParam = params.length;

  const result = await query<{
    source_id: string;
    file_id: string;
    storage_path: string;
    processed_artifacts_root: string | null;
  }>(
    `SELECT
       s.id AS source_id,
       f.id AS file_id,
       f.storage_path,
       f.processed_artifacts_root
     FROM files f
     JOIN sources s ON s.id = f.source_id
     WHERE ${accessFilter.sql}
       AND s.deleted_at IS NULL
       AND f.deleted_at IS NULL
       AND f.mime_type = 'application/pdf'
       AND s.id = $${sourceParam}
       AND f.id = $${fileParam}
     LIMIT 1`,
    params,
  );

  const row = result.rows[0];
  if (!row) return null;

  return {
    sourceId: row.source_id,
    fileId: row.file_id,
    storagePath: row.storage_path,
    artifactsRoot: row.processed_artifacts_root,
  };
}

export async function readOrRenderCitationPreviewPng(
  file: CitationPreviewFile,
  page: number,
): Promise<Buffer> {
  assertCanonicalCitationPreviewPaths(file);
  const cachePath = citationPreviewCachePath({
    sourceId: file.sourceId,
    fileId: file.fileId,
    page,
    artifactsRoot: file.artifactsRoot,
  });

  try {
    return await readCitationPreviewPng(cachePath);
  } catch {
    // Cache miss: render exactly one page below.
  }

  await renderPdfPageToPng({ pdfPath: file.storagePath, outputPath: cachePath, page });
  return readCitationPreviewPng(cachePath);
}

export function assertCanonicalCitationPreviewPaths(file: CitationPreviewFile): void {
  if (resolve(file.storagePath) !== resolve(originalFilePath(file.sourceId, file.fileId))) {
    throw new CitationPreviewError("source_file_missing");
  }
  if (file.artifactsRoot) {
    const expectedRoot = resolve(artifactsRootPath(file.sourceId, file.fileId));
    const actualRoot = resolve(file.artifactsRoot);
    const fromExpected = relative(expectedRoot, actualRoot);
    if (fromExpected === ".." || fromExpected.startsWith(`..${sep}`) || resolve(expectedRoot, fromExpected) !== actualRoot) {
      throw new CitationPreviewError("cache_unwritable");
    }
  }
}

export async function renderPdfPageToPng(input: Readonly<{ pdfPath: string; outputPath: string; page: number; renderTimeoutMs?: number }>): Promise<void> {
  const prepared = await prepareRender(input.pdfPath, input.outputPath, input.page);
  const temporaryName = `.${prepared.outputName}.${randomUUID()}.tmp.png`;
  const temporaryPrefix = `/proc/self/fd/4/${temporaryName.slice(0, -4)}`;
  const temporaryPng = `/proc/self/fd/${prepared.outputDirectory.fd}/${temporaryName}`;
  const finalPng = `/proc/self/fd/${prepared.outputDirectory.fd}/${prepared.outputName}`;
  try {
    await runPdfTool(
      "pdftoppm",
      [
        "-f",
        String(input.page),
        "-l",
        String(input.page),
        "-singlefile",
        "-scale-to",
        String(PREVIEW_WIDTH_PX),
        "-png",
        "/proc/self/fd/3",
        temporaryPrefix,
      ],
      input.renderTimeoutMs ?? RENDER_TIMEOUT_MS - PDF_INFO_TIMEOUT_MS,
      [prepared.pdf, prepared.outputDirectory],
    );
    await readPngFromDirectory(prepared.outputDirectory, temporaryName);
    await rename(temporaryPng, finalPng);
  } finally {
    await unlink(temporaryPng).catch(() => {});
    await prepared.pdf.close();
    await prepared.outputDirectory.close();
  }
}

export async function lookupChunkBbox(
  user: RetrievalUser,
  chunkId: string,
): Promise<(CitationPreviewRequest & { bbox: ChunkBbox }) | null> {
  const filter = buildRetrievalAuthorizationFilter(user);
  const accessFilter = buildSourceAccessSql(filter);
  const params = [...accessFilter.params, chunkId];
  const chunkParam = params.length;

  const result = await query<{
    source_id: string;
    file_id: string;
    page_number: number | null;
    bbox: ChunkBbox | null;
  }>(
    `SELECT c.source_id, c.file_id, c.page_number, c.bbox
     FROM chunks c
     JOIN sources s ON s.id = c.source_id
     JOIN files f ON f.id = c.file_id
     WHERE s.deleted_at IS NULL
       AND f.deleted_at IS NULL
       AND ${accessFilter.sql}
       AND c.id = $${chunkParam}
     LIMIT 1`,
    params,
  );

  const row = result.rows[0];
  if (!row || row.page_number == null || !row.bbox) return null;

  return {
    sourceId: row.source_id,
    fileId: row.file_id,
    page: row.page_number,
    bbox: row.bbox,
  };
}

const CROP_DPI = 200;

export async function renderCroppedPdfRegionToPng(input: Readonly<{
  pdfPath: string;
  outputPath: string;
  page: number;
  bbox: ChunkBbox;
  paddingPx?: number;
}>): Promise<void> {
  const { bbox } = input;
  if (![bbox.x1, bbox.y1, bbox.x2, bbox.y2].every(Number.isFinite) || bbox.x1 < 0 || bbox.y1 < 0 || bbox.x1 >= bbox.x2 || bbox.y1 >= bbox.y2) {
    throw new CitationPreviewError("render_failed");
  }
  const prepared = await prepareRender(input.pdfPath, input.outputPath, input.page);

  const padding = input.paddingPx ?? 10;
  const scale = CROP_DPI / 72;

  const rawX = bbox.x1 * scale - padding;
  const rawY = bbox.y1 * scale - padding;
  const rawW = (bbox.x2 - bbox.x1) * scale + padding * 2;
  const rawH = (bbox.y2 - bbox.y1) * scale + padding * 2;

  const x = Math.max(0, Math.round(rawX));
  const y = Math.max(0, Math.round(rawY));
  const w = Math.min(MAX_CROP_DIMENSION_PX, Math.max(1, Math.round(rawW)));
  const h = Math.min(MAX_CROP_DIMENSION_PX, Math.max(1, Math.round(rawH)));
  const temporaryName = `.${prepared.outputName}.${randomUUID()}.tmp.png`;
  const temporaryPrefix = `/proc/self/fd/4/${temporaryName.slice(0, -4)}`;
  const temporaryPng = `/proc/self/fd/${prepared.outputDirectory.fd}/${temporaryName}`;
  const finalPng = `/proc/self/fd/${prepared.outputDirectory.fd}/${prepared.outputName}`;
  try {
    await runPdfTool(
      "pdftocairo",
      [
        "-f", String(input.page),
        "-l", String(input.page),
        "-singlefile",
        "-r", String(CROP_DPI),
        "-x", String(x),
        "-y", String(y),
        "-W", String(w),
        "-H", String(h),
        "-png",
        "/proc/self/fd/3",
        temporaryPrefix,
      ],
      RENDER_TIMEOUT_MS - PDF_INFO_TIMEOUT_MS,
      [prepared.pdf, prepared.outputDirectory],
    );
    await readPngFromDirectory(prepared.outputDirectory, temporaryName);
    await rename(temporaryPng, finalPng);
  } finally {
    await unlink(temporaryPng).catch(() => {});
    await prepared.pdf.close();
    await prepared.outputDirectory.close();
  }
}

async function prepareRender(pdfPath: string, outputPath: string, page: number): Promise<{ pdf: FileHandle; outputDirectory: FileHandle; outputName: string }> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PREVIEW_PAGE) {
    throw new CitationPreviewError("page_not_found");
  }
  const pdf = await openConfinedRegularFile(pdfPath, "source_file_missing");
  let output: ConfinedParent | undefined;
  try {
    output = await openConfinedParent(outputPath, "cache_unwritable", true);
    const result = await runPdfTool("pdfinfo", ["/proc/self/fd/3"], PDF_INFO_TIMEOUT_MS, [pdf]);
    const pages = /^Pages:\s+(\d+)\s*$/m.exec(result.stdout)?.[1];
    if (!pages) throw new CitationPreviewError("render_failed");
    if (page > Number(pages)) throw new CitationPreviewError("page_not_found");
    return { pdf, outputDirectory: output.directory, outputName: output.name };
  } catch (error) {
    await pdf.close();
    await output?.directory.close();
    throw error;
  }
}

export async function readCitationPreviewPng(path: string): Promise<Buffer> {
  const parent = await openConfinedParent(path, "output_invalid", false);
  try {
    return await readPngFromDirectory(parent.directory, parent.name);
  } finally {
    await parent.directory.close();
  }
}

async function readPngFromDirectory(directory: FileHandle, name: string): Promise<Buffer> {
  const descriptorPath = `/proc/self/fd/${directory.fd}/${name}`;
  let handle: FileHandle | undefined;
  let identity: { dev: bigint; ino: bigint } | undefined;
  try {
    const before = await lstat(descriptorPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new CitationPreviewError("output_invalid");
    handle = await open(descriptorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptor = await handle.stat({ bigint: true });
    identity = { dev: descriptor.dev, ino: descriptor.ino };
    if (!descriptor.isFile() || descriptor.dev !== before.dev || descriptor.ino !== before.ino) {
      throw new CitationPreviewError("output_invalid");
    }
    const size = Number(descriptor.size);
    if (!Number.isSafeInteger(size) || size < 20 || size > MAX_PREVIEW_BYTES) {
      throw new CitationPreviewError("output_invalid");
    }
    const image = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const { bytesRead } = await handle.read(image, offset, size - offset, offset);
      if (bytesRead === 0) throw new CitationPreviewError("output_invalid");
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const extraRead = await handle.read(extra, 0, 1, size);
    const after = await handle.stat({ bigint: true });
    if (extraRead.bytesRead !== 0 || after.dev !== descriptor.dev || after.ino !== descriptor.ino || after.size !== descriptor.size) {
      throw new CitationPreviewError("output_invalid");
    }
    if (!isValidPng(image)) throw new CitationPreviewError("output_invalid");
    return image;
  } catch (error) {
    if (error instanceof CitationPreviewError && identity) await unlinkIfIdentity(descriptorPath, identity);
    throw error;
  } finally {
    await handle?.close();
  }
}

export function isValidCitationPreviewPng(image: Buffer): boolean {
  return isValidPng(image);
}

function isValidPng(image: Buffer): boolean {
  if (image.byteLength < 57 || image.byteLength > MAX_PREVIEW_BYTES || !image.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  let chunks = 0;
  let ihdr = 0;
  let idatBytes = 0;
  let iend = 0;
  let expectedScanlineBytes = 0;
  let rowBytes = 0;
  let height = 0;
  let idatEnded = false;
  const idatChunks: Buffer[] = [];
  while (offset < image.byteLength) {
    if (offset + 12 > image.byteLength) return false;
    const length = image.readUInt32BE(offset);
    const typeOffset = offset + 4;
    const dataOffset = typeOffset + 4;
    const crcOffset = dataOffset + length;
    const nextOffset = crcOffset + 4;
    if (length > MAX_PREVIEW_BYTES || nextOffset > image.byteLength) return false;
    const typeBytes = image.subarray(typeOffset, dataOffset);
    if (![...typeBytes].every(isAsciiLetter) || !isAsciiUppercase(typeBytes[2])) return false;
    const type = image.readUInt32BE(typeOffset);
    const knownCritical = type === PNG_IHDR || type === PNG_PLTE || type === PNG_IDAT || type === PNG_IEND;
    if (isAsciiUppercase(typeBytes[0]) && !knownCritical) return false;
    if (pngCrc32(image, typeOffset, crcOffset) !== image.readUInt32BE(crcOffset)) return false;
    chunks += 1;
    if (type === PNG_IHDR) {
      ihdr += 1;
      if (chunks !== 1 || ihdr !== 1 || length !== 13) return false;
      const width = image.readUInt32BE(dataOffset);
      height = image.readUInt32BE(dataOffset + 4);
      if (width < 1 || height < 1 || width > MAX_PREVIEW_DIMENSION_PX || height > MAX_PREVIEW_DIMENSION_PX) return false;
      const bitDepth = image[dataOffset + 8];
      const colorType = image[dataOffset + 9];
      const compression = image[dataOffset + 10];
      const filter = image[dataOffset + 11];
      const interlace = image[dataOffset + 12];
      const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
      if (bitDepth !== 8 || channels === 0 || compression !== 0 || filter !== 0 || interlace !== 0) return false;
      const rowBits = width * channels * bitDepth;
      if (!Number.isSafeInteger(rowBits)) return false;
      rowBytes = Math.ceil(rowBits / 8);
      expectedScanlineBytes = (rowBytes + 1) * height;
      if (!Number.isSafeInteger(expectedScanlineBytes) || expectedScanlineBytes > MAX_PREVIEW_DECOMPRESSED_BYTES) return false;
    } else if (type === PNG_IDAT) {
      if (ihdr !== 1 || iend !== 0 || idatEnded) return false;
      idatBytes += length;
      if (idatBytes > MAX_PREVIEW_BYTES) return false;
      idatChunks.push(image.subarray(dataOffset, crcOffset));
    } else if (type === PNG_IEND) {
      iend += 1;
      if (length !== 0 || iend !== 1 || ihdr !== 1 || idatBytes === 0 || nextOffset !== image.byteLength) return false;
    } else if (idatBytes > 0) {
      idatEnded = true;
    }
    offset = nextOffset;
  }
  if (ihdr !== 1 || idatBytes === 0 || iend !== 1 || expectedScanlineBytes === 0) return false;
  try {
    const scanlines = inflateSync(Buffer.concat(idatChunks, idatBytes), { maxOutputLength: expectedScanlineBytes });
    if (scanlines.byteLength !== expectedScanlineBytes) return false;
    for (let row = 0; row < height; row += 1) {
      if (scanlines[row * (rowBytes + 1)] > 4) return false;
    }
  } catch {
    return false;
  }
  return true;
}

function isAsciiLetter(value: number): boolean {
  return isAsciiUppercase(value) || (value >= 0x61 && value <= 0x7a);
}

function isAsciiUppercase(value: number): boolean {
  return value >= 0x41 && value <= 0x5a;
}

const PNG_CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function pngCrc32(buffer: Buffer, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = PNG_CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function runPdfTool(command: "pdfinfo" | "pdftoppm" | "pdftocairo", args: readonly string[], timeoutMs: number, inherited: readonly FileHandle[] = []): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe", ...inherited.map((handle) => handle.fd)],
    });
    const output: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    let timedOut = false;
    let forcedError: CitationPreviewError | undefined;
    const finish = (error?: CitationPreviewError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ stdout: Buffer.concat(output).toString("utf8") });
    };
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_TOOL_OUTPUT_BYTES) {
        forcedError = new CitationPreviewError("render_failed");
        child.kill("SIGKILL");
        return;
      }
      output.push(chunk);
    };
    child.stdout!.on("data", collect);
    child.stderr!.on("data", collect);
    child.once("error", (error: NodeJS.ErrnoException) => {
      finish(new CitationPreviewError(error.code === "ENOENT" ? "renderer_unavailable" : "render_failed"));
    });
    child.once("close", (code) => {
      if (timedOut) finish(new CitationPreviewError("render_timeout"));
      else if (forcedError) finish(forcedError);
      else finish(code === 0 ? undefined : new CitationPreviewError("render_failed"));
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
  });
}

async function openConfinedRegularFile(path: string, code: CitationPreviewErrorCode): Promise<FileHandle> {
  const parent = await openConfinedParent(path, code, false);
  const descriptorPath = `/proc/self/fd/${parent.directory.fd}/${parent.name}`;
  let handle: FileHandle | undefined;
  try {
    const before = await lstat(descriptorPath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) throw new CitationPreviewError(code);
    handle = await open(descriptorPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const descriptor = await handle.stat({ bigint: true });
    if (!descriptor.isFile() || descriptor.dev !== before.dev || descriptor.ino !== before.ino) throw new CitationPreviewError(code);
    return handle;
  } catch (error) {
    await handle?.close();
    if (error instanceof CitationPreviewError) throw error;
    throw new CitationPreviewError(code);
  } finally {
    await parent.directory.close();
  }
}

type ConfinedParent = Readonly<{ directory: FileHandle; name: string }>;

async function openConfinedParent(path: string, code: CitationPreviewErrorCode, create: boolean): Promise<ConfinedParent> {
  if (!path || path !== path.trim() || path.includes("\0")) throw new CitationPreviewError(code);
  const rawSegments = path.split(/[\\/]/).filter(Boolean);
  if (rawSegments.some((segment) => segment === "." || segment === ".." || segment.startsWith("-"))) throw new CitationPreviewError(code);
  const root = await canonicalStorageRoot(code);
  const absolute = resolve(path);
  const fromRoot = relative(root, absolute);
  if (!fromRoot || fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || resolve(root, fromRoot) !== absolute) throw new CitationPreviewError(code);
  const components = fromRoot.split(sep);
  const name = components.pop();
  if (!name) throw new CitationPreviewError(code);
  let directory = await openDirectory(root, code);
  try {
    for (const component of components) {
      const childPath = `/proc/self/fd/${directory.fd}/${component}`;
      if (create) {
        try {
          await mkdir(childPath, { mode: 0o700 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new CitationPreviewError(code);
        }
      }
      const child = await openDirectory(childPath, code);
      await directory.close();
      directory = child;
    }
    if (!create) {
      const resolved = await realpath(absolute).catch(() => { throw new CitationPreviewError(code); });
      if (resolved !== absolute) throw new CitationPreviewError(code);
    }
    return { directory, name };
  } catch (error) {
    await directory.close();
    throw error instanceof CitationPreviewError ? error : new CitationPreviewError(code);
  }
}

async function openDirectory(path: string, code: CitationPreviewErrorCode): Promise<FileHandle> {
  let directory: FileHandle | undefined;
  try {
    const before = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink()) throw new CitationPreviewError(code);
    directory = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const descriptor = await directory.stat({ bigint: true });
    if (!descriptor.isDirectory() || descriptor.dev !== before.dev || descriptor.ino !== before.ino) throw new CitationPreviewError(code);
    return directory;
  } catch (error) {
    await directory?.close();
    throw error instanceof CitationPreviewError ? error : new CitationPreviewError(code);
  }
}

async function canonicalStorageRoot(code: CitationPreviewErrorCode): Promise<string> {
  const configured = resolve(getStorageRoot());
  try {
    const resolved = await realpath(configured);
    if (resolved !== configured) throw new CitationPreviewError(code);
    return configured;
  } catch (error) {
    throw error instanceof CitationPreviewError ? error : new CitationPreviewError(code);
  }
}

async function unlinkIfIdentity(path: string, identity: { dev: bigint; ino: bigint }): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (current.dev === identity.dev && current.ino === identity.ino) await unlink(path);
  } catch {
    // The invalid cache entry is already absent or was replaced concurrently.
  }
}

export function croppedPreviewCachePath(
  input: CitationPreviewRequest & { bbox: ChunkBbox; artifactsRoot?: string | null },
): string {
  const root = input.artifactsRoot ?? artifactsRootPath(input.sourceId, input.fileId);
  const bboxSlug = `${Math.round(input.bbox.x1)}-${Math.round(input.bbox.y1)}-${Math.round(input.bbox.x2)}-${Math.round(input.bbox.y2)}`;
  return join(root, "previews", `page-${input.page}-crop-${bboxSlug}.png`);
}

export type CitationPreviewErrorCode =
  | "cache_unwritable"
  | "output_invalid"
  | "page_not_found"
  | "renderer_unavailable"
  | "render_failed"
  | "render_timeout"
  | "source_file_missing";

export class CitationPreviewError extends Error {
  readonly code: CitationPreviewErrorCode;

  constructor(code: CitationPreviewErrorCode) {
    super(code);
    this.name = "CitationPreviewError";
    this.code = code;
  }
}

export class CitationPreviewInputError extends Error {}
