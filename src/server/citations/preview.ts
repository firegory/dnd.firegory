/**
 * Server-side citation PDF preview rendering.
 *
 * The preview flow deliberately renders one requested page to an image and
 * never exposes the original PDF path or a public PDF URL to the client.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { artifactsRootPath } from "../ingestion/paths.ts";
import type { ChunkBbox } from "../../worker/ingestion/bbox.ts";

export const MAX_PREVIEW_PAGE = 5000;
export const PREVIEW_WIDTH_PX = 1400;
export const RENDER_TIMEOUT_MS = 30_000;
export const MAX_PREVIEW_BYTES = 16 * 1024 * 1024;

const PDF_INFO_TIMEOUT_MS = 5_000;
const MAX_CROP_DIMENSION_PX = 2000;
const MAX_PREVIEW_DIMENSION_PX = MAX_CROP_DIMENSION_PX;
const MAX_TOOL_OUTPUT_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

export async function renderPdfPageToPng(input: Readonly<{ pdfPath: string; outputPath: string; page: number; renderTimeoutMs?: number }>): Promise<void> {
  await prepareRender(input.pdfPath, input.outputPath, input.page);
  const temporaryPrefix = `${input.outputPath}.${randomUUID()}.tmp`;
  const temporaryPng = `${temporaryPrefix}.png`;
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
        input.pdfPath,
        temporaryPrefix,
      ],
      input.renderTimeoutMs ?? RENDER_TIMEOUT_MS - PDF_INFO_TIMEOUT_MS,
    );
    await validateRenderedPng(temporaryPng);
    await rename(temporaryPng, input.outputPath);
  } finally {
    await unlink(temporaryPng).catch(() => {});
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
  await prepareRender(input.pdfPath, input.outputPath, input.page);

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
  const temporaryPrefix = `${input.outputPath}.${randomUUID()}.tmp`;
  const temporaryPng = `${temporaryPrefix}.png`;
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
        input.pdfPath,
        temporaryPrefix,
      ],
      RENDER_TIMEOUT_MS - PDF_INFO_TIMEOUT_MS,
    );
    await validateRenderedPng(temporaryPng);
    await rename(temporaryPng, input.outputPath);
  } finally {
    await unlink(temporaryPng).catch(() => {});
  }
}

async function prepareRender(pdfPath: string, outputPath: string, page: number): Promise<void> {
  if (!Number.isInteger(page) || page < 1 || page > MAX_PREVIEW_PAGE) {
    throw new CitationPreviewError("page_not_found");
  }
  try {
    await access(pdfPath, fsConstants.R_OK);
  } catch {
    throw new CitationPreviewError("source_file_missing");
  }
  await mkdir(dirname(outputPath), { recursive: true }).catch(() => {
    throw new CitationPreviewError("cache_unwritable");
  });
  const result = await runPdfTool("pdfinfo", [pdfPath], PDF_INFO_TIMEOUT_MS);
  const pages = /^Pages:\s+(\d+)\s*$/m.exec(result.stdout)?.[1];
  if (!pages) throw new CitationPreviewError("render_failed");
  if (page > Number(pages)) throw new CitationPreviewError("page_not_found");
}

export async function readCitationPreviewPng(path: string): Promise<Buffer> {
  const image = await readFile(path);
  if (image.byteLength > MAX_PREVIEW_BYTES || !isBoundedPng(image)) {
    await unlink(path).catch(() => {});
    throw new CitationPreviewError("output_invalid");
  }
  return image;
}

async function validateRenderedPng(path: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new CitationPreviewError("render_failed");
  }
  if (size < 24 || size > MAX_PREVIEW_BYTES) {
    throw new CitationPreviewError("output_invalid");
  }
  const image = await readFile(path);
  if (!isBoundedPng(image)) {
    throw new CitationPreviewError("output_invalid");
  }
}

function isBoundedPng(image: Buffer): boolean {
  if (image.byteLength < 24 || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  if (image.subarray(12, 16).toString("ascii") !== "IHDR") return false;
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  return width > 0 && height > 0 && width <= MAX_PREVIEW_DIMENSION_PX && height <= MAX_PREVIEW_DIMENSION_PX;
}

async function runPdfTool(command: "pdfinfo" | "pdftoppm" | "pdftocairo", args: readonly string[], timeoutMs: number): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "pipe"],
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
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
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
