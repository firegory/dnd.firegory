import { NextResponse } from "next/server";

import { requireAdmin } from "../../../../../server/auth/session";
import { listEntitiesForMerge } from "../../../../../server/entities/storage";
import { isEntityType } from "../../../../../server/entities/types";

export async function GET(request: Request) {
  try {
    await requireAdmin();
  } catch {
    return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const entityType = searchParams.get("entityType");
  if (!entityType || !isEntityType(entityType)) {
    return NextResponse.json({ error: "Valid entityType required" }, { status: 400 });
  }

  const entities = await listEntitiesForMerge(entityType);
  return NextResponse.json({ items: entities });
}
