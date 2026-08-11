import {
  evidenceSegments,
  resolveSegmentSelections,
  sourceCitation,
  type AnswerLanguage,
  type RawLlmResponse,
  type SourceCitation,
} from "./format.ts";
import type { RetrievalCandidate } from "../retrieval/types.ts";

export type AnswerFallbackReason =
  | "insufficient_retrieval"
  | "provider_not_configured"
  | "provider_config_error"
  | "provider_unavailable"
  | "malformed_selection"
  | "partial_response"
  | "no_selection"
  | "selection_normalized";

export type GroundedClaim = Readonly<{
  text: string;
  citations: readonly SourceCitation[];
}>;

export type GroundedAnswer = Readonly<{
  answer: string;
  claims: readonly GroundedClaim[];
  citations: readonly SourceCitation[];
  confident: boolean;
  retrievedChunks: number;
  fallbackReason: AnswerFallbackReason | null;
}>;

export function groundGeneratedAnswer(
  parsed: RawLlmResponse,
  chunks: readonly RetrievalCandidate[],
  language: AnswerLanguage,
): GroundedAnswer {
  if (parsed.rejected) return extractiveFallback(language, chunks, "malformed_selection");
  if (parsed.selections.length === 0) return extractiveFallback(language, chunks, "no_selection");

  const selected = resolveSegmentSelections(parsed.selections, chunks);
  if (!selected) return extractiveFallback(language, chunks, "malformed_selection");

  const claims = selected.map((segment) => ({
    text: segment.text,
    citations: [sourceCitation(segment.chunk, segment.text)],
  }));
  return {
    answer: claims.map((claim) => claim.text).join("\n\n"),
    claims,
    citations: uniqueCitations(claims.flatMap((claim) => claim.citations)),
    confident: !parsed.normalized,
    retrievedChunks: chunks.length,
    fallbackReason: parsed.normalized ? "selection_normalized" : null,
  };
}

export function unsupportedAnswer(language: AnswerLanguage, retrievedChunks: number): GroundedAnswer {
  const messages: Record<AnswerLanguage, string> = {
    en: "I could not find relevant information in the available sources for your query.",
    ru: "Не удалось найти релевантную информацию в доступных источниках по вашему запросу.",
  };
  return {
    answer: messages[language], claims: [], citations: [], confident: false, retrievedChunks,
    fallbackReason: "insufficient_retrieval",
  };
}

export function extractiveFallback(
  language: AnswerLanguage,
  chunks: readonly RetrievalCandidate[],
  reason: Exclude<AnswerFallbackReason, "insufficient_retrieval" | "selection_normalized"> = "provider_unavailable",
): GroundedAnswer {
  if (chunks.length === 0) return unsupportedAnswer(language, 0);
  const messages = FALLBACK_MESSAGES[language];
  const citations = chunks.slice(0, 3).flatMap((chunk) => {
    const segment = evidenceSegments([chunk])[0];
    return segment ? [sourceCitation(chunk, segment.text)] : [];
  });
  return {
    answer: messages[reason],
    claims: [],
    citations,
    confident: false,
    retrievedChunks: chunks.length,
    fallbackReason: reason,
  };
}

const FALLBACK_MESSAGES: Record<AnswerLanguage, Record<Exclude<AnswerFallbackReason, "insufficient_retrieval" | "selection_normalized">, string>> = {
  en: {
    provider_not_configured: "AI answer generation is not configured. Review the retrieved source excerpts below.",
    provider_config_error: "AI answer generation is misconfigured. Review the retrieved source excerpts below.",
    provider_unavailable: "The AI provider is unavailable. Review the retrieved source excerpts below.",
    malformed_selection: "The AI response could not be safely validated. Review the retrieved source excerpts below.",
    partial_response: "The AI response was incomplete. Review the retrieved source excerpts below.",
    no_selection: "No directly supporting segment was selected. Review the retrieved source excerpts below.",
  },
  ru: {
    provider_not_configured: "Генерация ответа ИИ не настроена. Ниже приведены найденные фрагменты источников.",
    provider_config_error: "Генерация ответа ИИ настроена неверно. Ниже приведены найденные фрагменты источников.",
    provider_unavailable: "Провайдер ИИ недоступен. Ниже приведены найденные фрагменты источников.",
    malformed_selection: "Ответ ИИ не прошёл безопасную проверку. Ниже приведены найденные фрагменты источников.",
    partial_response: "Ответ ИИ был получен не полностью. Ниже приведены найденные фрагменты источников.",
    no_selection: "Подходящий подтверждающий фрагмент не выбран. Ниже приведены найденные фрагменты источников.",
  },
};

function uniqueCitations(citations: readonly SourceCitation[]): SourceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.chunkId}\u0000${citation.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
