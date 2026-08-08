import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../../../server/compendium/http";
import { parseFlatSelection, parseFlatType } from "../../../../../server/compendium/flat-http";
import { FlatNotFoundError, FlatReadInputError, FlatReadService } from "../../../../../server/compendium/flat-read-service";

export async function GET(request: Request, context: { params: Promise<{ type: string; identifier: string }> }): Promise<NextResponse> {
  const user = await getCurrentUser(); if (!user) return authenticationRequired();
  try { const params = await context.params; return NextResponse.json(await new FlatReadService().get(retrievalUser(user), parseFlatType(params.type), decodeURIComponent(params.identifier), parseFlatSelection(new URL(request.url)))); }
  catch (error) { if (error instanceof FlatReadInputError) return NextResponse.json({ error: error.message }, { status: 400 }); if (error instanceof FlatNotFoundError) return NextResponse.json({ error: "Entry not found." }, { status: 404 }); const response = compendiumErrorResponse(error); if (response) return response; throw error; }
}
