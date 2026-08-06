import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../../server/admin/admin-context";
import { CompendiumImportReviewService, ImportReviewError, type ReviewAction } from "../../../../../../../server/compendium/import-review";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try {
    const body: unknown = await request.json();
    if (!isRecord(body) || !Array.isArray(body.candidateIds) || typeof body.action !== "string") {
      throw new ImportReviewError("action and candidateIds are required.");
    }
    const { runId } = await context.params;
    const results = await new CompendiumImportReviewService().act(admin, runId, {
      candidateIds: body.candidateIds.filter((value): value is string => typeof value === "string"),
      action: body.action as ReviewAction,
      resolvedContent: isRecord(body.resolvedContent) ? body.resolvedContent : undefined,
      resolvedContents: isRecordOfRecords(body.resolvedContents) ? body.resolvedContents : undefined,
    });
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    if (error instanceof ImportReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Import review action failed.", error);
    return NextResponse.json({ error: "Import review action failed." }, { status: 500 });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordOfRecords(value: unknown): value is Record<string, Record<string, unknown>> {
  return isRecord(value) && Object.values(value).every(isRecord);
}
