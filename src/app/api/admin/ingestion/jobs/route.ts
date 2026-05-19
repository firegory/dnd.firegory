import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../server/auth/session";
import { listIngestionJobs, type IngestionJobRecord } from "../../../../../server/ingestion/storage";

export async function GET(request: Request) {
  let user;
  try {
    user = await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  void user; // used for auth gate only

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");

  const validStatuses = new Set<string>(["queued", "processing", "succeeded", "failed", "cancelled"]);
  const limit = limitParam ? Math.min(Math.max(parseInt(limitParam, 10) || 50, 1), 200) : 50;
  const offset = offsetParam ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;

  if (status && !validStatuses.has(status)) {
    return NextResponse.json(
      { error: `Invalid status filter. Must be one of: ${[...validStatuses].join(", ")}.` },
      { status: 400 },
    );
  }

  try {
    const jobs = await listIngestionJobs({
      status: status as IngestionJobRecord["status"] | undefined,
      limit,
      offset,
    });
    return NextResponse.json({ jobs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to list jobs.";
    console.error("List ingestion jobs error:", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
