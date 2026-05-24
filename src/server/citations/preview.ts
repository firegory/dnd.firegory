/**
 * Server-side citation PDF preview rendering.
 *
 * The preview flow deliberately renders one requested page to an image and
 * never exposes the original PDF path or a public PDF URL to the client.
 */

import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import { buildSourceAccessSql } from "../access/access-sql.ts";
import { buildRetrievalAuthorizationFilter, type RetrievalUser } from "../access/retrieval-filter.ts";
import { query } from "../db/client.ts";
import { artifactsRootPath } from "../ingestion/paths.ts";
import type { ChunkBbox } from "../../worker/ingestion/bbox.ts";

const execFileAsync = promisify(execFile);

export const MAX_PREVIEW_PAGE = 5000;
export const PREVIEW_WIDTH_PX = 1400;
export const RENDER_TIMEOUT_MS = 30_000;

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
    return await readFile(cachePath);
  } catch {
    // Cache miss: render exactly one page below.
  }

  await renderPdfPageToPng({ pdfPath: file.storagePath, outputPath: cachePath, page });
  return readFile(cachePath);
}

export async function renderPdfPageToPng(input: Readonly<{ pdfPath: string; outputPath: string; page: number }>): Promise<void> {
  await access(input.pdfPath, fsConstants.R_OK);
  await mkdir(dirname(input.outputPath), { recursive: true });

  const outputPrefix = input.outputPath.endsWith(".png")
    ? input.outputPath.slice(0, -".png".length)
    : input.outputPath;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    await execFileAsync(
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
        outputPrefix,
      ],
      { signal: controller.signal, timeout: RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
  } finally {
    clearTimeout(timeout);
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
  await access(input.pdfPath, fsConstants.R_OK);
  await mkdir(dirname(input.outputPath), { recursive: true });

  const { bbox } = input;
  if (bbox.x1 >= bbox.x2 || bbox.y1 >= bbox.y2) {
    throw new Error(`Invalid bbox: x1=${bbox.x1} >= x2=${bbox.x2} or y1=${bbox.y1} >= y2=${bbox.y2}`);
  }

  const padding = input.paddingPx ?? 10;
  const scale = CROP_DPI / 72;

  const rawX = bbox.x1 * scale - padding;
  const rawY = bbox.y1 * scale - padding;
  const rawW = (bbox.x2 - bbox.x1) * scale + padding * 2;
  const rawH = (bbox.y2 - bbox.y1) * scale + padding * 2;

  const x = Math.max(0, Math.round(rawX));
  const y = Math.max(0, Math.round(rawY));
  const w = Math.max(1, Math.round(rawW));
  const h = Math.max(1, Math.round(rawH));

  const outputPrefix = input.outputPath.endsWith(".png")
    ? input.outputPath.slice(0, -".png".length)
    : input.outputPath;
  const tmpPrefix = outputPrefix + ".tmp";

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), RENDER_TIMEOUT_MS);
  try {
    await unlink(tmpPrefix + ".png").catch(() => {});
    await execFileAsync(
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
        tmpPrefix,
      ],
      { signal: controller.signal, timeout: RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    );
    await rename(tmpPrefix + ".png", input.outputPath);
  } catch (err) {
    await unlink(tmpPrefix + ".png").catch(() => {});
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function croppedPreviewCachePath(
  input: CitationPreviewRequest & { bbox: ChunkBbox; artifactsRoot?: string | null },
): string {
  const root = input.artifactsRoot ?? artifactsRootPath(input.sourceId, input.fileId);
  const bboxSlug = `${Math.round(input.bbox.x1)}-${Math.round(input.bbox.y1)}-${Math.round(input.bbox.x2)}-${Math.round(input.bbox.y2)}`;
  return join(root, "previews", `page-${input.page}-crop-${bboxSlug}.png`);
}

export class CitationPreviewInputError extends Error {}
