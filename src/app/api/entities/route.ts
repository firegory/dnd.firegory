import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../server/auth/session";
import { getAccessibleSourceIds } from "../../../server/access/retrieval-filter";
import {
  listEntitiesByType,
  countEntitiesByType,
} from "../../../server/entities/storage";
import { isEntityType, ENTITY_TYPES, ENTITY_CONFIG } from "../../../server/entities/types";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);

  const typeParam = searchParams.get("type");

  if (typeParam === "__counts") {
    const counts = await countEntitiesByType();
    return NextResponse.json({ counts });
  }

  if (!typeParam || !isEntityType(typeParam)) {
    return NextResponse.json(
      { error: `Valid "type" parameter is required. One of: ${ENTITY_TYPES.join(", ")}` },
      { status: 400 },
    );
  }

  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(searchParams.get("pageSize") ?? "20", 10)));

  const config = ENTITY_CONFIG[typeParam];
  const filters: Record<string, string> = {};
  for (const filterDef of config.filters) {
    const value = searchParams.get(filterDef.key);
    if (value) filters[filterDef.key] = value;
  }

  const sourceIds = await getAccessibleSourceIds({
    role: user.role,
    userId: user.id,
  });

  const result = await listEntitiesByType(typeParam, {
    filters: Object.keys(filters).length > 0 ? filters : undefined,
    page,
    pageSize,
    sourceIds,
  });

  return NextResponse.json(result);
}
