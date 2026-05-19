/**
 * RAG answer generation pipeline.
 *
 * Takes a user query, runs hybrid retrieval, constructs a citation-first
 * prompt, calls the z.ai LLM, and extracts structured citations from
 * the response.
 *
 * Design principles:
 * - Answer language follows the selected UI language, not the query language.
 * - Source quotes come only from retrieved authorized chunks.
 * - Low-confidence/no-support cases produce a clear "not found" response.
 * - Citation extraction is format-driven: the LLM is asked to produce
 *   a specific JSON structure, and we parse it robustly.
 */

import { hybridSearch, type HybridSearchResult } from "../retrieval/pipeline";
import { chatCompletion, type ChatMessage, type LlmConfig } from "../llm/zai";
import type { RetrievalUser, RetrievalSelection } from "../access/retrieval-filter";
import {
  buildSystemPrompt,
  buildUserMessage,
  parseLlmResponse,
  mapCitations,
  type AnswerLanguage,
  type SourceCitation,
} from "./format";

// Re-export format utilities for direct testing
export {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  parseLlmResponse,
  mapCitations,
  type AnswerLanguage,
  type SourceCitation,
  type RawLlmCitation,
  type RawLlmResponse,
} from "./format";

// ---------- Public types ----------

export type AnswerRequest = Readonly<{
  /** The user's question. */
  query: string;
  /** Authenticated user for access control. */
  user: RetrievalUser;
  /** Optional corpus selection filters. */
  selection?: RetrievalSelection;
  /** Language for the generated answer. */
  answerLanguage: AnswerLanguage;
  /** Maximum final retrieval candidates to use as context. */
  retrievalLimit?: number;
  /** Optional LLM config overrides. */
  llmConfig?: Partial<LlmConfig>;
}>;

export type RagAnswer = Readonly<{
  /** Short direct answer. */
  answer: string;
  /** Structured citations backing the answer. */
  citations: readonly SourceCitation[];
  /** Whether the answer was generated from confident retrieval results. */
  confident: boolean;
  /** The retrieval candidates used as context (for diagnostics). */
  retrievedChunks: number;
}>;

export type AnswerPipelineResult = Readonly<{
  answer: RagAnswer;
  retrieval: HybridSearchResult;
  llmModel: string;
  usage: Readonly<{
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
  }>;
}>;

// ---------- Minimum chunk confidence ----------

/** Minimum number of retrieval results to attempt a confident answer. */
const MIN_CHUNKS_FOR_CONFIDENT_ANSWER = 1;

// ---------- Main pipeline ----------

/**
 * Executes the full RAG answer pipeline.
 *
 * 1. Run hybrid retrieval with access filters.
 * 2. If insufficient results, return a no-support answer immediately.
 * 3. Build citation-first prompt from retrieval results.
 * 4. Call z.ai LLM.
 * 5. Parse structured response and map citations.
 */
export async function generateAnswer(
  request: AnswerRequest,
): Promise<AnswerPipelineResult> {
  const {
    query,
    user,
    selection = {},
    answerLanguage,
    retrievalLimit = 8,
    llmConfig,
  } = request;

  // 1. Hybrid retrieval
  const retrieval = await hybridSearch({
    query,
    user,
    selection,
    limit: retrievalLimit,
    expansionConfig: { enabled: true, bilingual: true },
    rerankConfig: { enabled: true },
  });

  const chunks = retrieval.chunks;

  // 2. Check if we have enough for a confident answer
  if (chunks.length < MIN_CHUNKS_FOR_CONFIDENT_ANSWER) {
    const noSupportAnswer = buildNoSupportAnswer(answerLanguage);
    return {
      answer: noSupportAnswer,
      retrieval,
      llmModel: "none",
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
      },
    };
  }

  // 3. Build prompt
  const systemPrompt = buildSystemPrompt(answerLanguage);
  const userMessage = buildUserMessage(query, chunks);

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];

  // 4. Call LLM
  const result = await chatCompletion(messages, llmConfig);

  // 5. Parse and map
  const parsed = parseLlmResponse(result.content);
  const citations = mapCitations(parsed.citations, chunks);

  const answer: RagAnswer = {
    answer: parsed.answer ?? result.content,
    citations,
    confident: parsed.confident !== false,
    retrievedChunks: chunks.length,
  };

  return {
    answer,
    retrieval,
    llmModel: result.model,
    usage: result.usage,
  };
}

/**
 * Builds a "no support found" answer without calling the LLM.
 */
function buildNoSupportAnswer(language: AnswerLanguage): RagAnswer {
  const messages: Record<AnswerLanguage, string> = {
    en: "I could not find relevant information in the available sources for your query.",
    ru: "Не удалось найти релевантную информацию в доступных источниках по вашему запросу.",
  };

  return {
    answer: messages[language],
    citations: [],
    confident: false,
    retrievedChunks: 0,
  };
}
