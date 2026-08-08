/**
 * RAG answer formatting utilities — pure functions.
 *
 * No external dependencies (no DB, no LLM calls, no retrieval pipeline).
 * Safe to import in unit tests with Node test runner.
 */

import type { EntityEvidence, RetrievalCandidate } from "../retrieval/types";

// ---------- Language type ----------

export type AnswerLanguage = "en" | "ru";

// ---------- Public citation types ----------

export type SourceCitation = Readonly<{
  /** Direct quote from the source. */
  quote: string;
  /** Source title. */
  sourceTitle: string;
  /** D&D edition. */
  edition: string;
  /** Source language. */
  language: string;
  /** Page number if available. */
  page: number | null;
  /** Section heading if available. */
  section: string | null;
  /** Source category. */
  category: string;
  /** Internal file ID for future preview links. */
  fileId: string;
  /** Internal source ID. */
  sourceId: string;
  /** Internal chunk ID for precise bbox preview. */
  chunkId: string;
  /** Citation-backed compendium fields supporting this quote, when present. */
  entityEvidence?: readonly CitationEntityEvidence[];
}>;

export type CitationEntityEvidence = Readonly<Pick<
  EntityEvidence,
  "entryId" | "citationId" | "citationKind" | "fieldPath"
>>;

// ---------- Prompt construction ----------

const LANGUAGE_INSTRUCTIONS: Record<AnswerLanguage, string> = {
  en: "Respond in English.",
  ru: "Отвечай на русском языке.",
};

/**
 * Builds the system prompt for citation-first RAG answers.
 */
export function buildSystemPrompt(language: AnswerLanguage): string {
  const langInstruction = LANGUAGE_INSTRUCTIONS[language];

  return `You are a precise D&D rules assistant. ${langInstruction}

You MUST follow these rules:

1. Answer ONLY from the provided source excerpts. Do not use outside knowledge.
2. If the provided sources do not contain enough information to answer, say so explicitly.
3. Start with a concise direct answer (1-3 sentences).
4. After the answer, provide direct quotes from sources that support it.
5. For each quote, cite the source title, edition, page, and section.
6. Omit structured fields or properties unless a provided quote explicitly supports them.

Your response MUST be valid JSON with this exact structure:
{
  "answer": "Your concise answer here.",
  "confident": true,
  "citations": [
    {
      "quote": "Exact quote from source.",
      "sourceTitle": "Source Title",
      "edition": "5e",
      "page": 42,
      "section": "Section Heading"
    }
  ]
}

If you cannot answer from the provided sources:
{
  "answer": "I could not find a definitive answer in the available sources.",
  "confident": false,
  "citations": []
}

Return ONLY the JSON object, no other text.`;
}

/**
 * Formats retrieval candidates into a context block for the LLM.
 */
export function formatRetrievalContext(
  chunks: readonly RetrievalCandidate[],
): string {
  if (chunks.length === 0) {
    return "No relevant sources found.";
  }

  return chunks
    .map((chunk, i) => {
      const lines: string[] = [];
      lines.push(`[Source ${i + 1}]`);
      lines.push(`Title: ${chunk.sourceTitle}`);
      lines.push(`Edition: ${chunk.edition}`);
      lines.push(`Language: ${chunk.language}`);
      if (chunk.pageNumber !== null) {
        lines.push(`Page: ${chunk.pageNumber}`);
      }
      if (chunk.sectionHeading) {
        lines.push(`Section: ${chunk.sectionHeading}`);
      }
      lines.push(`Category: ${chunk.sourceCategory}`);
      lines.push(`Quote: "${chunk.quoteText}"`);
      for (const evidence of chunk.entityEvidence ?? []) {
        const field = evidence.fieldPath ? ` ${evidence.fieldPath}` : "";
        lines.push(`Carried ${evidence.citationKind} citation${field}: "${evidence.quote}"`);
      }
      lines.push("");
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Builds the user message combining the query with retrieval context.
 */
export function buildUserMessage(
  query: string,
  chunks: readonly RetrievalCandidate[],
): string {
  const context = formatRetrievalContext(chunks);
  return `Question: ${query}\n\nAvailable sources:\n\n${context}`;
}

// ---------- Citation extraction ----------

export type RawLlmCitation = Readonly<{
  quote?: string;
  sourceTitle?: string;
  edition?: string;
  page?: number | null;
  section?: string | null;
}>;

export type RawLlmResponse = Readonly<{
  answer?: string;
  confident?: boolean;
  citations?: readonly RawLlmCitation[];
}>;

/**
 * Parses the LLM response JSON robustly.
 *
 * Handles cases where the LLM wraps JSON in markdown code blocks
 * or adds extra whitespace.
 */
export function parseLlmResponse(raw: string): RawLlmResponse {
  let text = raw.trim();

  // Strip markdown code block wrapping if present
  if (text.startsWith("```")) {
    const firstNewline = text.indexOf("\n");
    if (firstNewline !== -1) {
      text = text.slice(firstNewline + 1);
    }
    if (text.endsWith("```")) {
      text = text.slice(0, -3);
    }
    text = text.trim();
  }

  try {
    return sanitizeLlmResponse(JSON.parse(text));
  } catch {
    const braceStart = text.indexOf("{");
    if (braceStart !== -1) {
      let depth = 0;
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        if (depth === 0) {
          try {
            return sanitizeLlmResponse(JSON.parse(text.slice(braceStart, i + 1)));
          } catch {
            break;
          }
        }
      }
      const fixed = text.slice(braceStart) + "]}";
      try {
        return sanitizeLlmResponse(JSON.parse(fixed));
      } catch {
        const partial = text.slice(braceStart) + "]";
        try {
          return sanitizeLlmResponse(JSON.parse(partial));
        } catch {
          const quotesMatch = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/);
          const answer = quotesMatch?.[1]
            ? JSON.parse(`"${quotesMatch[1]}"`)
            : raw;
          return { answer, confident: false, citations: [] };
        }
      }
    }
    return { answer: raw, confident: false, citations: [] };
  }
}

function sanitizeLlmResponse(value: unknown): RawLlmResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const citations = Array.isArray(raw.citations)
    ? raw.citations.flatMap((citation): RawLlmCitation[] => {
        if (!citation || typeof citation !== "object" || Array.isArray(citation)) return [];
        const item = citation as Record<string, unknown>;
        return [{
          ...(typeof item.quote === "string" ? { quote: item.quote } : {}),
          ...(typeof item.sourceTitle === "string" ? { sourceTitle: item.sourceTitle } : {}),
          ...(typeof item.edition === "string" ? { edition: item.edition } : {}),
          ...(item.page === null || typeof item.page === "number" ? { page: item.page as number | null } : {}),
          ...(item.section === null || typeof item.section === "string" ? { section: item.section as string | null } : {}),
        }];
      })
    : undefined;
  return {
    ...(typeof raw.answer === "string" ? { answer: raw.answer } : {}),
    ...(typeof raw.confident === "boolean" ? { confident: raw.confident } : {}),
    ...(citations ? { citations } : {}),
  };
}

/**
 * Maps LLM citations to structured source citations with chunk matching.
 *
 * Accepts only normalized contiguous substrings of retrieved source quotes,
 * then returns authoritative quote and location data from the matched chunk.
 */
export function mapCitations(
  rawCitations: readonly RawLlmCitation[] | undefined,
  chunks: readonly RetrievalCandidate[],
): SourceCitation[] {
  if (!rawCitations) return [];

  const citations: SourceCitation[] = [];

  for (const raw of rawCitations) {
    if (!raw.quote) continue;

    const support = findCitationSupport(raw, chunks);

    if (support) {
      const { chunk: matchedChunk, evidence } = support;
      citations.push({
        quote: support.quote,
        sourceTitle: matchedChunk.sourceTitle,
        edition: matchedChunk.edition,
        language: matchedChunk.language,
        page: matchedChunk.pageNumber,
        section: matchedChunk.sectionHeading,
        category: matchedChunk.sourceCategory,
        fileId: matchedChunk.fileId,
        sourceId: matchedChunk.sourceId,
        chunkId: matchedChunk.chunkId,
        ...(evidence.length ? { entityEvidence: evidence.map(citationEntityEvidence) } : {}),
      });
    }
  }

  return citations;
}

export function citationEntityEvidence(evidence: EntityEvidence): CitationEntityEvidence {
  return {
    entryId: evidence.entryId,
    citationId: evidence.citationId,
    citationKind: evidence.citationKind,
    fieldPath: evidence.fieldPath,
  };
}

type CitationSupport = Readonly<{
  chunk: RetrievalCandidate;
  quote: string;
  evidence: readonly EntityEvidence[];
}>;

function findCitationSupport(
  citation: RawLlmCitation,
  chunks: readonly RetrievalCandidate[],
): CitationSupport | undefined {
  if (!citation.quote) return undefined;
  const titleMatches = citation.sourceTitle
    ? chunks.filter((chunk) => chunk.sourceTitle.localeCompare(citation.sourceTitle!, undefined, { sensitivity: "accent" }) === 0)
    : [];
  const candidates = [...titleMatches, ...chunks.filter((chunk) => !titleMatches.includes(chunk))];

  for (const chunk of candidates) {
    for (const evidence of chunk.entityEvidence ?? []) {
      if (isNormalizedSubstring(citation.quote, evidence.quote)) {
        return {
          chunk,
          quote: evidence.quote,
          evidence: evidenceWithinSpan(chunk, evidence.quote),
        };
      }
    }
    if (isNormalizedSubstring(citation.quote, chunk.quoteText)) {
      return {
        chunk,
        quote: chunk.quoteText,
        evidence: evidenceWithinSpan(chunk, chunk.quoteText),
      };
    }
  }
  return undefined;
}

function evidenceWithinSpan(
  chunk: RetrievalCandidate,
  authoritativeQuote: string,
): readonly EntityEvidence[] {
  return chunk.entityEvidence?.filter((evidence) =>
    isNormalizedSubstring(evidence.quote, authoritativeQuote),
  ) ?? [];
}

function isNormalizedSubstring(quote: string, source: string): boolean {
  const normalizedQuote = normalizeCitationText(quote);
  return normalizedQuote.length >= 8 && normalizeCitationText(source).includes(normalizedQuote);
}

function normalizeCitationText(value: string): string {
  return value.normalize("NFC").replaceAll(/\s+/g, " ").trim().toLowerCase();
}
