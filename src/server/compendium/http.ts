import { NextResponse } from "next/server";

import type { RetrievalSelection } from "../access/retrieval-filter.ts";
import { SOURCE_CATEGORIES, SOURCE_EDITIONS, SOURCE_LANGUAGES } from "../access/retrieval-filter.ts";
import type { SessionUser } from "../auth/types.ts";
import { CompendiumNotFoundError, CompendiumReadInputError } from "./read-service.ts";

export function retrievalUser(user: SessionUser) {
  return { role: user.role, userId: user.id } as const;
}

export function parseSelection(url: URL): RetrievalSelection {
  const edition = url.searchParams.get("edition") ?? undefined;
  const language = url.searchParams.get("language") ?? undefined;
  const category = url.searchParams.get("category") ?? undefined;
  if (edition && !SOURCE_EDITIONS.includes(edition as never)) throw new CompendiumReadInputError("Invalid edition.");
  if (language && !SOURCE_LANGUAGES.includes(language as never)) throw new CompendiumReadInputError("Invalid language.");
  if (category && !SOURCE_CATEGORIES.includes(category as never)) throw new CompendiumReadInputError("Invalid category.");
  return {
    ...(edition ? { edition: edition as RetrievalSelection["edition"] } : {}),
    ...(language ? { language: language as RetrievalSelection["language"] } : {}),
    ...(category ? { category: category as RetrievalSelection["category"] } : {}),
  };
}

export function compendiumErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof CompendiumNotFoundError) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  if (error instanceof CompendiumReadInputError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  return null;
}

export function authenticationRequired(): NextResponse {
  return NextResponse.json({ error: "Authentication required." }, { status: 401 });
}
