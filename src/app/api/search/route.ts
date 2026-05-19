import { NextResponse } from "next/server";

import { searchChunks } from "../../../server/search/service";
import { getCurrentUser } from "../../../server/auth/session";

export type SearchRequestBody = Readonly<{
  query: string;
  edition?: "5e" | "5.5e";
  language?: "en" | "ru";
  category?: "core_rules" | "official_supplement" | "homebrew";
  limit?: number;
  offset?: number;
}>;

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Authentication required." }, { status: 401 });
  }

  let body: SearchRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  if (!body.query || typeof body.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }

  const result = await searchChunks({
    query: body.query,
    user: { role: user.role, userId: user.id },
    selection: {
      ...(body.edition ? { edition: body.edition } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(body.category ? { category: body.category } : {}),
    },
    limit: body.limit,
    offset: body.offset,
  });

  return NextResponse.json(result);
}
