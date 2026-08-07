import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../server/admin/admin-context";
import { EntryEditorService } from "../../../../../../server/compendium/entry-editor";
import { mapEntryEditorError } from "../../../../../../server/compendium/entry-editor-http";

export async function GET(request: Request) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try {
    const url = new URL(request.url);
    return NextResponse.json(await new EntryEditorService().evidence(admin, url.searchParams.get("sourceId") ?? undefined, url.searchParams.get("fileId") ?? undefined, url.searchParams.get("q") ?? ""));
  } catch (error) {
    const mapped = mapEntryEditorError(error);
    if (mapped) return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    console.error("Editor evidence lookup failed.", error);
    return NextResponse.json({ error: "Editor evidence lookup failed." }, { status: 500 });
  }
}
