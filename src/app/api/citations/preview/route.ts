import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import type { RetrievalUser } from "../../../../server/access/retrieval-filter";
import {
  CitationPreviewInputError,
  getAuthorizedCitationPreviewFile,
  parseCitationPreviewRequest,
  parseChunkPreviewRequest,
  readOrRenderCitationPreviewPng,
  lookupChunkBbox,
  renderCroppedPdfRegionToPng,
  croppedPreviewCachePath,
} from "../../../../server/citations/preview";
import { readFile } from "node:fs/promises";

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
    return NextResponse.json(
      { error: "Chunk bbox not found. Re-ingest the source to enable precise previews." },
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
      const cached = await readFile(cachePath);
      return new NextResponse(new Uint8Array(cached), {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "private, max-age=86400",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      // Cache miss
    }

    await renderCroppedPdfRegionToPng({
      pdfPath: file.storagePath,
      outputPath: cachePath,
      page: chunkData.page,
      bbox: chunkData.bbox,
    });

    const image = await readFile(cachePath);
    return new NextResponse(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown render error";
    return NextResponse.json(
      { error: "Citation preview is unavailable.", detail: message.includes("ENOENT") ? "Original PDF is unavailable." : undefined },
      { status: 503 },
    );
  }
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
    return new NextResponse(new Uint8Array(image), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown render error";
    return NextResponse.json(
      { error: "Citation preview is unavailable.", detail: message.includes("ENOENT") ? "Original PDF is unavailable." : undefined },
      { status: 503 },
    );
  }
}
