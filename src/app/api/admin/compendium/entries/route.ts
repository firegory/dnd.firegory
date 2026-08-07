import { NextResponse } from "next/server";

import { resolveAdminContextFromRequest } from "../../../../../server/admin/admin-context";
import { EntryEditorService } from "../../../../../server/compendium/entry-editor";
import { mapEntryEditorError } from "../../../../../server/compendium/entry-editor-http";
import { assertSameOriginMutation, OriginValidationError } from "../../../../../server/http/same-origin";

export async function GET(request: Request) {
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try { return NextResponse.json({ entries: await new EntryEditorService().list(admin) }); }
  catch (error) { return failure(error, "Entry list failed."); }
}

export async function POST(request: Request) {
  try { assertSameOriginMutation(request); }
  catch (error) { if (error instanceof OriginValidationError) return NextResponse.json({ error: error.message }, { status: 403 }); throw error; }
  const admin = await resolveAdminContextFromRequest(request);
  if (!admin) return NextResponse.json({ error: "Admin role required." }, { status: 403 });
  try { return NextResponse.json(await new EntryEditorService().create(admin, await request.json()), { status: 201 }); }
  catch (error) { return failure(error, "Entry creation failed."); }
}

function failure(error: unknown, fallback: string) {
  const mapped = mapEntryEditorError(error);
  if (mapped) return NextResponse.json({ error: mapped.message }, { status: mapped.status });
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
