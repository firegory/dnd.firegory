import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, parseSelection, retrievalUser } from "../../../../server/compendium/http";
import { SpellNotFoundError, SpellReadService } from "../../../../server/compendium/spell-read-service";

type RouteContext = Readonly<{ params: Promise<{ identifier: string }> }>;

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return authenticationRequired();
  try {
    const { identifier } = await context.params;
    return NextResponse.json(await new SpellReadService().get(retrievalUser(user), identifier, parseSelection(new URL(request.url))));
  } catch (error) {
    if (error instanceof SpellNotFoundError) return NextResponse.json({ error: "Not found." }, { status: 404 });
    const response = compendiumErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
