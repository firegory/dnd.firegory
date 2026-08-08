import { mapCitations, type AnswerLanguage, type RawLlmResponse, type SourceCitation } from "./format.ts";
import type { RetrievalCandidate } from "../retrieval/types.ts";

export type GroundedAnswer = Readonly<{
  answer: string;
  citations: readonly SourceCitation[];
  confident: boolean;
  retrievedChunks: number;
}>;

export function groundGeneratedAnswer(
  parsed: RawLlmResponse,
  chunks: readonly RetrievalCandidate[],
  language: AnswerLanguage,
): GroundedAnswer {
  const rawCitations = parsed.citations?.filter((citation) => typeof citation.quote === "string" && !!citation.quote.trim()) ?? [];
  const citations = mapCitations(rawCitations, chunks);
  if (citations.length === 0) return unsupportedAnswer(language, chunks.length);

  return {
    answer: evidenceAnswer(language, citations),
    citations,
    confident: parsed.confident === true && citations.length === (parsed.citations?.length ?? 0),
    retrievedChunks: chunks.length,
  };
}

export function unsupportedAnswer(language: AnswerLanguage, retrievedChunks: number): GroundedAnswer {
  const messages: Record<AnswerLanguage, string> = {
    en: "I could not find relevant information in the available sources for your query.",
    ru: "Не удалось найти релевантную информацию в доступных источниках по вашему запросу.",
  };
  return { answer: messages[language], citations: [], confident: false, retrievedChunks };
}

function evidenceAnswer(language: AnswerLanguage, citations: readonly SourceCitation[]): string {
  const heading = language === "ru" ? "Подтверждённые фрагменты источников:" : "Validated source excerpts:";
  return `${heading}\n${citations.map((citation) => `- ${citation.quote}`).join("\n")}`;
}
