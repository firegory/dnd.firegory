import { mapCitations, type AnswerLanguage, type RawLlmResponse, type SourceCitation } from "./format.ts";
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
    const seen = new Set<string>();
    const uniqueReferences = claim.citations.filter((citation) => {
      if (seen.has(citation.contextId)) {
        rejected = true;
        return false;
      }
      seen.add(citation.contextId);
      return true;
    });
    const citations = mapCitations(uniqueReferences, chunks);
    if (citations.length !== uniqueReferences.length) rejected = true;
    if (citations.length === 0) {
      rejected = true;
      continue;
    }
    claims.push({ text: claim.text, citations });
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
    citations: chunks.slice(0, 3).map(sourceCitation),
    confident: false,
    retrievedChunks: chunks.length,
  };
}

function sourceCitation(chunk: RetrievalCandidate): SourceCitation {
  return {
    quote: chunk.quoteText,
    sourceTitle: chunk.sourceTitle,
    edition: chunk.edition,
    language: chunk.language,
    page: chunk.pageNumber,
    section: chunk.sectionHeading,
    category: chunk.sourceCategory,
    fileId: chunk.fileId,
    sourceId: chunk.sourceId,
    chunkId: chunk.chunkId,
    ...(chunk.entityEvidence?.length
      ? { entityEvidence: chunk.entityEvidence.map((evidence) => ({
          entryId: evidence.entryId,
          citationId: evidence.citationId,
          citationKind: evidence.citationKind,
          fieldPath: evidence.fieldPath,
        })) }
      : {}),
  };
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
