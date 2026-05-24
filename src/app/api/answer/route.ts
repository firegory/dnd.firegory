/**
 * Answer API route — citation-first RAG answers.
 *
 * POST /api/answer
 *
 * Accepts a query with optional corpus filters, runs hybrid retrieval
 * with access control, and generates a citation-first answer using z.ai.
 */

import { NextResponse } from "next/server";

import { generateAnswer } from "../../../server/rag/answer";
import { type AnswerLanguage } from "../../../server/rag/format";
import { getCurrentUser } from "../../../server/auth/session";
import type { SourceEdition, SourceLanguage, SourceCategory } from "../../../server/access/retrieval-filter";

export type AnswerRequestBody = Readonly<{
  query: string;
  edition?: SourceEdition;
  language?: SourceLanguage;
  category?: SourceCategory;
  answerLanguage?: AnswerLanguage;
  limit?: number;
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

  try {
    const result = await generateAnswer({
      query: body.query,
      user: { role: user.role, userId: user.id },
      selection: {
        ...(body.edition ? { edition: body.edition } : {}),
        ...(body.language ? { language: body.language } : {}),
        ...(body.category ? { category: body.category } : {}),
      },
      answerLanguage,
      retrievalLimit,
    });

    return NextResponse.json({
      answer: result.answer.answer,
      citations: result.answer.citations.map((c) => ({
        quote: c.quote,
        sourceTitle: c.sourceTitle,
        edition: c.edition,
        language: c.language,
        page: c.page,
        section: c.section,
        category: c.category,
        fileId: c.fileId,
        sourceId: c.sourceId,
        chunkId: c.chunkId,
      })),
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
    if (message.includes("ZAI_API_KEY")) {
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
