import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../server/admin/admin-context";
import { CompendiumImportReviewService, ImportReviewError } from "../../../../../../server/compendium/import-review";

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: Context) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try {
    const { runId } = await context.params;
    const result = await new CompendiumImportReviewService().getRun(admin, runId, new URL(request.url).searchParams.get("diffStatus") ?? undefined);
    return NextResponse.json(result);
  } catch (error) {
    return reviewError(error, "Failed to load import run.");
  }
}

function reviewError(error: unknown, fallback: string) {
  if (error instanceof ImportReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
