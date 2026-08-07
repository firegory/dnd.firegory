import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../../../server/admin/admin-context";
import { EntryEditorService } from "../../../../../../../server/compendium/entry-editor";
import { mapEntryEditorError } from "../../../../../../../server/compendium/entry-editor-http";
import { assertSameOriginMutation, OriginValidationError } from "../../../../../../../server/http/same-origin";

type Context = { params: Promise<{ versionId: string }> };

export async function POST(request: Request, context: Context) {
  try { assertSameOriginMutation(request); }
  catch (error) { if (error instanceof OriginValidationError) return NextResponse.json({ error: error.message }, { status: 403 }); throw error; }
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try { return NextResponse.json(await new EntryEditorService().requestPublication(admin, (await context.params).versionId, await request.json()), { status: 202 }); }
  catch (error) {
    const mapped = mapEntryEditorError(error);
    if (mapped) return NextResponse.json({ error: mapped.message }, { status: mapped.status });
    console.error("Publication request failed.", error);
    return NextResponse.json({ error: "Publication request failed." }, { status: 500 });
  }
}
