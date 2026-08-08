import { resolveAdminContextFromRequest } from "../admin/admin-context.ts";
import { CompendiumImportReviewService, ImportReviewError } from "./import-review.ts";
import { parseImportReviewActionRequest } from "./import-review-http.ts";
import { assertSameOriginMutation, OriginValidationError } from "../http/same-origin.ts";

type Context = { params: Promise<{ runId: string }> };
type Dependencies = Readonly<{
  resolveAdmin: typeof resolveAdminContextFromRequest;
  review: Pick<CompendiumImportReviewService, "act">;
}>;

export async function handleImportReviewAction(request: Request, context: Context, dependencies: Dependencies = {
  resolveAdmin: resolveAdminContextFromRequest,
  review: new CompendiumImportReviewService(),
}) {
  try {
    assertSameOriginMutation(request);
  } catch (error) {
    if (error instanceof OriginValidationError) return Response.json({ error: error.message }, { status: 403 });
    throw error;
  }
  const admin = await dependencies.resolveAdmin(request);
  if (!admin) return Response.json({ error: "Admin role required." }, { status: 403 });
  try {
    const body: unknown = await request.json();
    const input = parseImportReviewActionRequest(body);
    const { runId } = await context.params;
    const results = await dependencies.review.act(admin, runId, input);
    return Response.json({ results });
  } catch (error) {
    if (error instanceof SyntaxError) return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
    if (error instanceof ImportReviewError) return Response.json({ error: error.message }, { status: error.status });
    console.error("Import review action failed.", error);
    return Response.json({ error: "Import review action failed." }, { status: 500 });
  }
}
