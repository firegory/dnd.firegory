import { NextResponse } from "next/server";

import { hybridSearch } from "../../../server/retrieval/pipeline";
import { getCurrentUser } from "../../../server/auth/session";

export type SearchRequestBody = Readonly<{
  query: string;
  edition?: "5e" | "5.5e";
  language?: "en" | "ru";
  category?: "core_rules" | "official_supplement" | "homebrew";
  limit?: number;
  offset?: number;
}>;

const MAX_QUERY_LENGTH = 500;

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

  if (body.query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json({ error: "Query too long." }, { status: 400 });
  }

  const hybridResult = await hybridSearch({
    query: body.query,
    user: { role: user.role, userId: user.id },
    selection: {
      ...(body.edition ? { edition: body.edition } : {}),
      ...(body.language ? { language: body.language } : {}),
      ...(body.category ? { category: body.category } : {}),
    },
    limit: body.limit,
    expansionConfig: {
      enabled: true,
      bilingual: body.language === undefined, // bilingual only when no language selected
    },
    rerankConfig: {
      enabled: true,
    },
  });

  // Map hybrid result to the existing search API response shape
  // for backward compatibility. Strategy and score are included
  // for diagnostics but the core citation fields are unchanged.
  return NextResponse.json({
    chunks: hybridResult.chunks.map((c) => ({
      chunkId: c.chunkId,
      sourceId: c.sourceId,
      fileId: c.fileId,
      text: c.text,
      quoteText: c.quoteText,
      sectionHeading: c.sectionHeading,
      pageNumber: c.pageNumber,
      edition: c.edition,
      language: c.language,
      sourceTitle: c.sourceTitle,
      sourceCategory: c.sourceCategory,
      accessTier: c.accessTier,
      // New fields from hybrid retrieval
      score: c.score,
      strategy: c.strategy,
    })),
    total: hybridResult.totalMerged,
    hasMore: hybridResult.hasMore,
    expansions: hybridResult.expansions,
  });
}
