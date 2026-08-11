import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../../server/admin/admin-context.ts";
import { ContentMetadataService } from "../../../../../../../server/content/metadata.ts";
import { mapContentMetadataHttpError } from "../../../../../../../server/content/metadata-http.ts";

function getService(): ContentMetadataService {
  return new ContentMetadataService();
}

type RouteContext = Readonly<{ params: Promise<{ sourceId: string; fileId: string }> }>;

export async function GET(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId, fileId } = await context.params;
    return NextResponse.json(await getService().getFile(admin, sourceId, fileId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId, fileId } = await context.params;
    return NextResponse.json(await getService().updateFile(admin, sourceId, fileId, await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId, fileId } = await context.params;
    return NextResponse.json(await getService().deleteFile(admin, sourceId, fileId));
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
  const mapped = mapContentMetadataHttpError(error);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  throw error;
}
