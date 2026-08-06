import { NextResponse } from "next/server";

import { getCurrentUser } from "../../../../server/auth/session";
import { COMPENDIUM_ENTRY_TYPES, type CompendiumEntryType } from "../../../../server/compendium/service";
import { CompendiumReadInputError, CompendiumReadService } from "../../../../server/compendium/read-service";
import { authenticationRequired, compendiumErrorResponse, parseSelection, retrievalUser } from "../../../../server/compendium/http";

export async function GET(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) return authenticationRequired();
  try {
    const url = new URL(request.url);
    const rawType = url.searchParams.get("type") ?? undefined;
    if (rawType && !COMPENDIUM_ENTRY_TYPES.includes(rawType as CompendiumEntryType)) {
      throw new CompendiumReadInputError("Unsupported compendium entry type.");
    }
    const limit = optionalInteger(url, "limit");
    const offset = optionalInteger(url, "offset");
    return NextResponse.json(await new CompendiumReadService().listEntries(retrievalUser(user), {
      ...parseSelection(url),
      ...(rawType ? { entryType: rawType as CompendiumEntryType } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(offset !== undefined ? { offset } : {}),
    }));
  } catch (error) {
    const response = compendiumErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

function optionalInteger(url: URL, name: string): number | undefined {
  const value = url.searchParams.get(name);
  if (value === null || value === "") return undefined;
  if (!/^\d+$/.test(value)) throw new CompendiumReadInputError(`${name} must be an integer.`);
  return Number(value);
}
