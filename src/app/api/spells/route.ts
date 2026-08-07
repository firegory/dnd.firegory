import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../server/compendium/http";
import { parseSpellListOptions } from "../../../server/compendium/spell-http";
import { SpellReadInputError, SpellReadService } from "../../../server/compendium/spell-read-service";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return authenticationRequired();
  try {
    return NextResponse.json(await new SpellReadService().list(retrievalUser(user), parseSpellListOptions(new URL(request.url))));
  } catch (error) {
    if (error instanceof SpellReadInputError) return NextResponse.json({ error: error.message }, { status: 400 });
    const response = compendiumErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
