import { NextResponse } from "next/server";
import { getCurrentUser } from "../../../../server/auth/session";
import { authenticationRequired, compendiumErrorResponse, retrievalUser } from "../../../../server/compendium/http";
import { OptionReadService } from "../../../../server/compendium/option-read-service";
import {parseOptionVersionSelection} from "../../../../server/compendium/option-http";
export async function GET(request:Request,{params}:{params:Promise<{identifier:string}>}):Promise<NextResponse>{const user=await getCurrentUser();if(!user)return authenticationRequired();try{const {identifier}=await params;return NextResponse.json(await new OptionReadService().get("class",retrievalUser(user),identifier,parseOptionVersionSelection(new URL(request.url))));}catch(error){const response=compendiumErrorResponse(error);if(response)return response;throw error;}}
