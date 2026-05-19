import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../../../server/auth/session";
import { reprocessSource } from "../../../../../../../server/ingestion/actions";

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
    const { job, queueId } = await reprocessSource(sourceId, user.id);
    return NextResponse.json({
      job: {
        id: job.id,
        kind: job.kind,
        status: job.status,
        sourceId: job.sourceId,
        fileId: job.fileId,
      },
      queueId,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Reprocess failed.";
    console.error("Reprocess source error:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
