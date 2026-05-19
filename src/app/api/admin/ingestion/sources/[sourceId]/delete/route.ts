import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../../../server/auth/session";
import { deleteSource } from "../../../../../../../server/ingestion/actions";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ sourceId: string }> },
) {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  const { sourceId } = await params;
  if (!sourceId) {
    return NextResponse.json({ error: "Source ID is required." }, { status: 400 });
  }

  try {
    const { cancelledJobs, removedFiles } = await deleteSource(sourceId, user.id);
    return NextResponse.json({
      sourceId,
      cancelledJobs,
      removedFiles,
      message: `Source ${sourceId} deleted successfully.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Delete failed.";
    console.error("Delete source error:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
