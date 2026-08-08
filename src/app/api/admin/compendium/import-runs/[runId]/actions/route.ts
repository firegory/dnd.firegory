import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../../server/admin/admin-context";
import { CompendiumImportReviewService, ImportReviewError } from "../../../../../../../server/compendium/import-review";
import { parseImportReviewActionRequest } from "../../../../../../../server/compendium/import-review-http";
import { assertSameOriginMutation, OriginValidationError } from "../../../../../../../server/http/same-origin";

type Context = { params: Promise<{ runId: string }> };
type Dependencies = Readonly<{
  resolveAdmin: typeof resolveAdminContextFromRequest;
  review: Pick<CompendiumImportReviewService, "act">;
}>;

export async function POST(request: Request, context: Context) {
  return handleImportReviewAction(request, context);
}

export async function handleImportReviewAction(request: Request, context: Context, dependencies: Dependencies = {
  resolveAdmin: resolveAdminContextFromRequest,
  review: new CompendiumImportReviewService(),
}) {
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    if (error instanceof OriginValidationError) return NextResponse.json({ error: error.message }, { status: 403 });
    throw error;
  }
  const admin = await dependencies.resolveAdmin(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try {
    const body: unknown = await request.json();
    const input = parseImportReviewActionRequest(body);
    const { runId } = await context.params;
    const results = await dependencies.review.act(admin, runId, input);
    return NextResponse.json({ results });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
    if (error instanceof ImportReviewError) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error("Import review action failed.", error);
    return NextResponse.json({ error: "Import review action failed." }, { status: 500 });
  }
}
