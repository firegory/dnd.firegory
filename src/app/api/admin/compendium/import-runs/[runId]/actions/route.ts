import { handleImportReviewAction } from "../../../../../../../server/compendium/import-review-action-handler";

type Context = { params: Promise<{ runId: string }> };

export async function POST(request: Request, context: Context) {
  return handleImportReviewAction(request, context);
}
