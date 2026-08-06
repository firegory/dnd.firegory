import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../server/admin/admin-context";
import { CompendiumImportReviewService, ImportReviewError } from "../../../../../server/compendium/import-review";

export async function GET(request: Request) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  const url = new URL(request.url);
  try {
    const runs = await new CompendiumImportReviewService().listRuns(admin, {
      status: url.searchParams.get("status") ?? undefined,
      limit: parseInteger(url.searchParams.get("limit")),
      offset: parseInteger(url.searchParams.get("offset")),
    });
    return NextResponse.json({ runs });
  } catch (error) {
    return reviewError(error, "Failed to list import runs.");
  }
}

function parseInteger(value: string | null): number | undefined {
  if (value == null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function reviewError(error: unknown, fallback: string) {
  if (error instanceof ImportReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
