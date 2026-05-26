import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import { getAccessibleSourceIds } from "../../../../server/access/retrieval-filter";
import { getEntityById } from "../../../../server/entities/storage";

type RouteContext = Readonly<{ params: Promise<{ id: string }> }>;

export async function GET(_request: Request, context: RouteContext) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "Entity ID is required." }, { status: 400 });
  }

  const entity = await getEntityById(id);
  if (!entity) {
    return NextResponse.json({ error: "Entity not found." }, { status: 404 });
  }

  const accessibleSourceIds = await getAccessibleSourceIds({
    role: user.role,
    userId: user.id,
  });
  if (!accessibleSourceIds.includes(entity.sourceId)) {
    return NextResponse.json({ error: "Entity not found." }, { status: 404 });
  }

  return NextResponse.json({
    id: entity.id,
    entityType: entity.entityType,
    name: entity.name,
    description: entity.description,
    attributes: entity.attributes,
    pageNumbers: entity.pageNumbers,
    chunkIds: entity.chunkIds,
    sourceId: entity.sourceId,
    sourceTitle: entity.sourceTitle,
    fileId: entity.fileId,
    createdAt: entity.createdAt,
  });
}
