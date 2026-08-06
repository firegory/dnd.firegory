import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, parseSelection, retrievalUser } from "../../../../../server/compendium/http";
import { CompendiumReadService } from "../../../../../server/compendium/read-service";

type RouteContext = Readonly<{ params: Promise<{ alias: string }> }>;

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return authenticationRequired();
  try {
    const { alias } = await context.params;
    return NextResponse.json(await new CompendiumReadService().resolveAlias(
      retrievalUser(user),
      alias,
      parseSelection(new URL(request.url)),
    ));
  } catch (error) {
    const response = compendiumErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
