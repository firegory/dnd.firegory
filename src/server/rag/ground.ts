import {
  resolveContextReferences,
  sourceCitation,
  type AnswerLanguage,
  type RawLlmResponse,
  type SourceCitation,
} from "./format.ts";
import { validateClaimSupport } from "./support.ts";
import type { RetrievalCandidate } from "../retrieval/types.ts";

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
}>;

export function groundGeneratedAnswer(
  parsed: RawLlmResponse,
  chunks: readonly RetrievalCandidate[],
  language: AnswerLanguage,
): GroundedAnswer {
  let rejected = parsed.rejected;
  const claims: GroundedClaim[] = [];

  for (const claim of parsed.claims) {
    const supportingChunks = resolveContextReferences(claim.references, chunks);
    if (!supportingChunks || !validateClaimSupport(claim.text, supportingChunks, language).supported) {
      rejected = true;
      continue;
    }
    claims.push({ text: claim.text, citations: supportingChunks.map((chunk) => sourceCitation(chunk)) });
  }

  if (claims.length === 0) return extractiveFallback(language, chunks);
  return {
    answer: claims.map((claim) => claim.text).join("\n\n"),
    claims,
    citations: uniqueCitations(claims.flatMap((claim) => claim.citations)),
    confident: !rejected,
    retrievedChunks: chunks.length,
  };
}

export function unsupportedAnswer(language: AnswerLanguage, retrievedChunks: number): GroundedAnswer {
  const messages: Record<AnswerLanguage, string> = {
    en: "I could not find relevant information in the available sources for your query.",
    ru: "Не удалось найти релевантную информацию в доступных источниках по вашему запросу.",
  };
  return { answer: messages[language], claims: [], citations: [], confident: false, retrievedChunks };
}

export function extractiveFallback(
  language: AnswerLanguage,
  chunks: readonly RetrievalCandidate[],
): GroundedAnswer {
  if (chunks.length === 0) return unsupportedAnswer(language, 0);
  const messages: Record<AnswerLanguage, string> = {
    en: "A supported AI summary is unavailable. Review the validated source excerpts below.",
    ru: "Подтверждённое ИИ-резюме недоступно. Ниже приведены проверенные фрагменты источников.",
  };
  return {
    answer: messages[language],
    claims: [],
    citations: fallbackCitations(chunks),
    confident: false,
    retrievedChunks: chunks.length,
  };
}

function fallbackCitations(chunks: readonly RetrievalCandidate[]): SourceCitation[] {
  const citations: SourceCitation[] = [];
  for (const chunk of chunks) {
    const quote = cleanExcerpt(chunk.quoteText);
    if (quote) citations.push(sourceCitation(chunk, quote));
    if (citations.length === 3) break;
  }
  return citations;
}

function cleanExcerpt(value: string): string {
  const normalized = value.normalize("NFC").replaceAll(/\s+/g, " ").trim();
  if (normalized.length <= 600) return normalized;
  const boundary = normalized.lastIndexOf(" ", 600);
  return normalized.slice(0, boundary >= 400 ? boundary : 600).trimEnd();
}

function uniqueCitations(citations: readonly SourceCitation[]): SourceCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = `${citation.chunkId}\u0000${citation.quote}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
