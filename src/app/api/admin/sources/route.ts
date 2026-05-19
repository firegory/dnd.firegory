import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../server/admin/admin-context.ts";
import {
  ContentMetadataNotFoundError,
  ContentMetadataService,
  ContentMetadataValidationError,
  type ListSourcesOptions,
} from "../../../../server/content/metadata.ts";

function getService(): ContentMetadataService {
  return new ContentMetadataService();
}

export async function GET(request: Request) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  const url = new URL(request.url);
  const options: ListSourcesOptions = {
    includeDeleted: url.searchParams.get("includeDeleted") === "true",
    category: optionalParam(url, "category"),
    edition: optionalParam(url, "edition"),
    language: optionalParam(url, "language"),
    accessTier: optionalParam(url, "accessTier"),
  };

  try {
    return NextResponse.json({ sources: await getService().listSources(admin, options) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return forbidden();

  try {
    return NextResponse.json(await getService().createSource(admin, await request.json()), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

function optionalParam(url: URL, name: string): never | undefined {
  return (url.searchParams.get(name) ?? undefined) as never | undefined;
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
