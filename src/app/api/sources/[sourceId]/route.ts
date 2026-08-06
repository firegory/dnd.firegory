import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../../server/compendium/http";
import { CompendiumReadService } from "../../../../server/compendium/read-service";

type RouteContext = Readonly<{ params: Promise<{ sourceId: string }> }>;

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return authenticationRequired();
  try {
    const { sourceId } = await context.params;
    return NextResponse.json(await new CompendiumReadService().getSource(retrievalUser(user), sourceId));
  } catch (error) {
    const response = compendiumErrorResponse(error);
    if (response) return response;
    throw error;
  }
}
