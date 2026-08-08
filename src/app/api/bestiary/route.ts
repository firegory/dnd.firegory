import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../server/compendium/http";
import { parseCreatureListOptions } from "../../../server/compendium/creature-http";
import { CreatureReadInputError, CreatureReadService } from "../../../server/compendium/creature-read-service";
export async function GET(request: Request): Promise<NextResponse> { const user = await getCurrentUser(); if (!user) return authenticationRequired(); try { return NextResponse.json(await new CreatureReadService().list(retrievalUser(user), parseCreatureListOptions(new URL(request.url)))); } catch (error) { if (error instanceof CreatureReadInputError) return NextResponse.json({ error: error.message }, { status: 400 }); const response = compendiumErrorResponse(error); if (response) return response; throw error; } }
