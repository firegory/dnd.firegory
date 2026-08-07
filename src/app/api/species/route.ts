import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../server/compendium/http";
import { parseOptionListOptions } from "../../../server/compendium/option-http";
import { OptionReadService } from "../../../server/compendium/option-read-service";
export async function GET(request: Request): Promise<NextResponse> { const user=await getCurrentUser();if(!user)return authenticationRequired();try{const result=await new OptionReadService().list("species",retrievalUser(user),parseOptionListOptions("species",new URL(request.url)));return NextResponse.json({species:result.options,count:result.count});}catch(error){const response=compendiumErrorResponse(error);if(response)return response;throw error;} }
