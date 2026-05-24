import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import {
  CitationPreviewInputError,
  getAuthorizedCitationPreviewFile,
  parseCitationPreviewRequest,
  readOrRenderCitationPreviewPng,
} from "../../../../server/citations/preview";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let input;
  try {
    input = parseCitationPreviewRequest(new URL(request.url));
  } catch (error) {
    if (error instanceof CitationPreviewInputError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const file = await getAuthorizedCitationPreviewFile(
    { role: user.role, userId: user.id },
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
