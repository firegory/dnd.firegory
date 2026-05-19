import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../../../server/auth/session";
import { retryFailedJob } from "../../../../../../../server/ingestion/actions";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
) {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  const { jobId } = await params;
  if (!jobId) {
    return NextResponse.json({ error: "Job ID is required." }, { status: 400 });
  }

  try {
    const { job, queueId } = await retryFailedJob(jobId, user.id);
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
    const message = err instanceof Error ? err.message : "Retry failed.";
    console.error("Retry ingestion job error:", err);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
