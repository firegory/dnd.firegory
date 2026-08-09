/**
 * Answer API route — citation-first RAG answers.
 *
 * POST /api/answer
 *
 * Accepts a query with optional corpus filters, runs hybrid retrieval
 * with access control, and generates a citation-first answer using the
 * configured LLM provider.
 */

import { NextResponse } from "next/server";

import { generateAnswer } from "../../../server/rag/answer";
import { type AnswerLanguage } from "../../../server/rag/format";
import { getCurrentUser } from "../../../server/auth/session";
import {
  SOURCE_CATEGORIES,
  SOURCE_EDITIONS,
  SOURCE_LANGUAGES,
  type RetrievalSelection,
  type SourceEdition,
  type SourceLanguage,
  type SourceCategory,
} from "../../../server/access/retrieval-filter";
import {
  entryScopeConflictsWithSelection,
  isCompendiumEntryScope,
  type CompendiumEntryScope,
} from "../../../server/retrieval/entity";

export type AnswerRequestBody = Readonly<{
  query: string;
  edition?: SourceEdition;
  language?: SourceLanguage;
  category?: SourceCategory;
  answerLanguage?: AnswerLanguage;
  limit?: number;
  entryScope?: CompendiumEntryScope;
}>;

const MAX_QUERY_LENGTH = 500;
const VALID_ANSWER_LANGUAGES: readonly AnswerLanguage[] = ["en", "ru"];

export async function POST(request: Request): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 },
    );
  }

  let body: AnswerRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Validate query
  if (!body.query || typeof body.query !== "string" || !body.query.trim()) {
    return NextResponse.json({ error: "Query is required." }, { status: 400 });
  }

  if (body.query.length > MAX_QUERY_LENGTH) {
    return NextResponse.json(
      { error: "Query too long." },
      { status: 400 },
    );
  }

  // Validate answerLanguage
  const answerLanguage: AnswerLanguage =
    body.answerLanguage && VALID_ANSWER_LANGUAGES.includes(body.answerLanguage)
      ? body.answerLanguage
      : "en";

  // Clamp retrieval limit to reasonable range
  const retrievalLimit = body.limit
    ? Math.min(Math.max(1, body.limit), 20)
    : undefined;

  if (body.entryScope !== undefined && !isCompendiumEntryScope(body.entryScope)) {
    return NextResponse.json({ error: "Invalid entry scope." }, { status: 400 });
  }

  if ((body.edition !== undefined && !SOURCE_EDITIONS.includes(body.edition))
    || (body.language !== undefined && !SOURCE_LANGUAGES.includes(body.language))
    || (body.category !== undefined && !SOURCE_CATEGORIES.includes(body.category))) {
    return NextResponse.json({ error: "Invalid source selection." }, { status: 400 });
  }

  const selection: RetrievalSelection = {
    ...(body.edition ? { edition: body.edition } : {}),
    ...(body.language ? { language: body.language } : {}),
    ...(body.category ? { category: body.category } : {}),
  };
  if (body.entryScope && entryScopeConflictsWithSelection(body.entryScope, selection)) {
    return NextResponse.json({ error: "Entry scope conflicts with source selection." }, { status: 400 });
  }

  try {
    const result = await generateAnswer({
      query: body.query,
      user: { role: user.role, userId: user.id },
      selection,
      answerLanguage,
      retrievalLimit,
      entryScope: body.entryScope,
    });

    return NextResponse.json({
      answer: result.answer.answer,
      claims: result.answer.claims.map((claim) => ({
        text: claim.text,
        citations: claim.citations.map(publicCitation),
      })),
      citations: result.answer.citations.map(publicCitation),
      confident: result.answer.confident,
      retrievedChunks: result.answer.retrievedChunks,
      meta: {
        model: result.llmModel,
        retrievalTotal: result.retrieval.totalMerged,
        retrievalHasMore: result.retrieval.hasMore,
        usage: result.usage,
      },
    });
  } catch (error: unknown) {
    // Graceful error without leaking secrets
    const message =
      error instanceof Error ? error.message : "Answer generation failed";

    // Check for API key config errors specifically
    if (message.includes("LLM_API_KEY is not configured")) {
      return NextResponse.json(
        { error: "Answer generation is not configured." },
        { status: 503 },
      );
    }

    return NextResponse.json(
      { error: "Answer generation failed. Please try again." },
      { status: 500 },
    );
  }
}

function publicCitation(citation: (Awaited<ReturnType<typeof generateAnswer>>)["answer"]["citations"][number]) {
  return {
    quote: citation.quote,
    sourceTitle: citation.sourceTitle,
    edition: citation.edition,
    language: citation.language,
    page: citation.page,
    section: citation.section,
    category: citation.category,
    fileId: citation.fileId,
    sourceId: citation.sourceId,
    chunkId: citation.chunkId,
    ...(citation.entityEvidence ? { entityEvidence: citation.entityEvidence } : {}),
  };
}
