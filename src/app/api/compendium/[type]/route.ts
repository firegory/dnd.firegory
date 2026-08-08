import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../../server/compendium/http";
import { parseFlatListOptions, parseFlatType } from "../../../../server/compendium/flat-http";
import { FlatReadInputError, FlatReadService } from "../../../../server/compendium/flat-read-service";

export async function GET(request: Request, context: { params: Promise<{ type: string }> }): Promise<NextResponse> {
  const user = await getCurrentUser(); if (!user) return authenticationRequired();
  try { const type = parseFlatType((await context.params).type); return NextResponse.json(await new FlatReadService().list(retrievalUser(user), type, parseFlatListOptions(new URL(request.url)))); }
  catch (error) { if (error instanceof FlatReadInputError) return NextResponse.json({ error: error.message }, { status: 400 }); const response = compendiumErrorResponse(error); if (response) return response; throw error; }
}
