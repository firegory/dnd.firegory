import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../server/admin/admin-context.ts";
import {
  ContentMetadataNotFoundError,
  ContentMetadataService,
  ContentMetadataValidationError,
} from "../../../../../server/content/metadata.ts";

function getService(): ContentMetadataService {
  return new ContentMetadataService();
}

type RouteContext = Readonly<{ params: Promise<{ sourceId: string }> }>;

export async function GET(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await getService().getSource(admin, sourceId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await getService().updateSource(admin, sourceId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await getService().deleteSource(admin, sourceId));
  } catch (error) {
    return errorResponse(error);
  }
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "Admin authentication is required. Auth adapter integration is tracked in issue #4." },
    { status: 403 },
  );
}

function errorResponse(error: unknown): NextResponse {
  if (error instanceof ContentMetadataValidationError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof ContentMetadataNotFoundError) {
    return NextResponse.json({ error: error.message }, { status: 404 });
  }
  throw error;
}
