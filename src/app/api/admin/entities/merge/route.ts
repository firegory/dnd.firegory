import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../server/auth/session";
import { mergeEntities } from "../../../../../server/entities/storage";
import { reprocessEntityDescription } from "../../../../../server/entities/actions";

export async function POST(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  let body: { targetId?: string; sourceIds?: string[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { targetId, sourceIds } = body;
  if (!targetId || !Array.isArray(sourceIds) || sourceIds.length === 0) {
    return NextResponse.json(
      { error: "targetId and non-empty sourceIds[] required" },
      { status: 400 },
    );
  }

  if (sourceIds.includes(targetId)) {
    return NextResponse.json(
      { error: "targetId must not be in sourceIds" },
      { status: 400 },
    );
  }

  try {
    await mergeEntities(targetId, sourceIds);
    await reprocessEntityDescription(targetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
