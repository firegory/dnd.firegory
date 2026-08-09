import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import type { RetrievalUser } from "../../../../server/access/retrieval-filter";
import {
  CitationPreviewInputError,
  getAuthorizedCitationPreviewFile,
  parseCitationPreviewRequest,
  parseChunkPreviewRequest,
  readOrRenderCitationPreviewPng,
  readCitationPreviewPng,
  lookupChunkBbox,
  renderCroppedPdfRegionToPng,
  croppedPreviewCachePath,
} from "../../../../server/citations/preview";
import { citationPreviewHttpError, logCitationPreviewError } from "../../../../server/citations/preview-http";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const retrievalUser: RetrievalUser = { role: user.role, userId: user.id };
  const url = new URL(request.url);

  // New path: chunkId-based cropped preview
  const chunkIdParam = url.searchParams.get("chunkId")?.trim();
  if (chunkIdParam) {
    return handleChunkPreview(url, retrievalUser);
  }

  // Legacy path: page-level preview
  return handlePagePreview(url, retrievalUser);
}

async function handleChunkPreview(
  url: URL,
  user: RetrievalUser,
): Promise<NextResponse> {
  let parsed;
  try {
    parsed = parseChunkPreviewRequest(url);
  } catch (error) {
    if (error instanceof CitationPreviewInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const chunkData = await lookupChunkBbox(user, parsed.chunkId);
  if (!chunkData) {
    if (hasPageFallback(url)) return handlePagePreview(url, user);
    return NextResponse.json(
      { error: "Citation preview not found." },
      { status: 404 },
    );
  }

  const file = await getAuthorizedCitationPreviewFile(
    user,
    { sourceId: chunkData.sourceId, fileId: chunkData.fileId },
  );
  if (!file) {
    return NextResponse.json({ error: "Citation preview not found." }, { status: 404 });
  }

  try {
    const cachePath = croppedPreviewCachePath({
      sourceId: chunkData.sourceId,
      fileId: chunkData.fileId,
      page: chunkData.page,
      bbox: chunkData.bbox,
      artifactsRoot: file.artifactsRoot,
    });

    try {
      const cached = await readCitationPreviewPng(cachePath);
      return imageResponse(cached);
    } catch {
      // Cache miss
    }

    await renderCroppedPdfRegionToPng({
      pdfPath: file.storagePath,
      outputPath: cachePath,
      page: chunkData.page,
      bbox: chunkData.bbox,
    });

    const image = await readCitationPreviewPng(cachePath);
    return imageResponse(image);
  } catch (error) {
    if (hasPageFallback(url)) return handlePagePreview(url, user);
    return renderErrorResponse(error, { kind: "chunk", chunkId: parsed.chunkId });
  }
}

function hasPageFallback(url: URL): boolean {
  return Boolean(url.searchParams.get("sourceId") && url.searchParams.get("fileId") && url.searchParams.get("page"));
}

async function handlePagePreview(
  url: URL,
  user: RetrievalUser,
): Promise<NextResponse> {
  let input;
  try {
    input = parseCitationPreviewRequest(url);
  } catch (error) {
    if (error instanceof CitationPreviewInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const file = await getAuthorizedCitationPreviewFile(
    user,
    { sourceId: input.sourceId, fileId: input.fileId },
  );
  if (!file) {
    return NextResponse.json({ error: "Citation preview not found." }, { status: 404 });
  }

  try {
    const image = await readOrRenderCitationPreviewPng(file, input.page);
    return imageResponse(image);
  } catch (error) {
    return renderErrorResponse(error, { kind: "page", sourceId: input.sourceId, fileId: input.fileId, page: input.page });
  }
}

function imageResponse(image: Buffer): NextResponse {
  return new NextResponse(new Uint8Array(image), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export function renderErrorResponse(error: unknown, context: Record<string, string | number>): NextResponse {
  logCitationPreviewError(error, context);
  const response = citationPreviewHttpError(error);
  return NextResponse.json(response.body, { status: response.status });
}
