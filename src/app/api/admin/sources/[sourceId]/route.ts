import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../server/admin/admin-context.ts";
import {
  ContentMetadataService,
} from "../../../../../server/content/metadata.ts";
import { mapContentMetadataHttpError } from "../../../../../server/content/metadata-http.ts";
import { archiveSource, mapSourceArchiveError } from "../../../../../server/content/source-lifecycle.ts";

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
    return sourceMetadataErrorResponse(error);
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await getService().updateSource(admin, sourceId, await request.json()));
  } catch (error) {
    return sourceMetadataErrorResponse(error);
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    const { sourceId } = await context.params;
    const body = await request.json().catch(() => null) as { confirmationTitle?: unknown } | null;
    return NextResponse.json(await archiveSource(sourceId, body?.confirmationTitle as string));
  } catch (error) {
    const archiveError = mapSourceArchiveError(error);
    if (archiveError) return NextResponse.json(archiveError.body, { status: archiveError.status });
    return sourceMetadataErrorResponse(error);
  }
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { error: "Admin authentication is required. Auth adapter integration is tracked in issue #4." },
    { status: 403 },
  );
}

function sourceMetadataErrorResponse(error: unknown): NextResponse {
  const mapped = mapContentMetadataHttpError(error);
  if (mapped) return NextResponse.json(mapped.body, { status: mapped.status });
  throw error;
}
