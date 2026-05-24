/**
 * RAG answer formatting utilities — pure functions.
 *
 * No external dependencies (no DB, no LLM calls, no retrieval pipeline).
 * Safe to import in unit tests with Node test runner.
 */

import type { RetrievalCandidate } from "../retrieval/types";

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
}>;

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
    return JSON.parse(text) as RawLlmResponse;
  } catch {
    const braceStart = text.indexOf("{");
    if (braceStart !== -1) {
      let depth = 0;
      for (let i = braceStart; i < text.length; i++) {
        if (text[i] === "{") depth++;
        else if (text[i] === "}") depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(braceStart, i + 1)) as RawLlmResponse;
          } catch {
            break;
          }
        }
      }
      const fixed = text.slice(braceStart) + "]}";
      try {
        return JSON.parse(fixed) as RawLlmResponse;
      } catch {
        const partial = text.slice(braceStart) + "]";
        try {
          const inner = JSON.parse(partial) as RawLlmResponse;
          return inner;
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

/**
 * Maps LLM citations to structured source citations with chunk matching.
 *
 * Tries to match each LLM citation to a retrieval candidate by source title
 * and quote text overlap, so we can include the internal IDs.
 */
export function mapCitations(
  rawCitations: readonly RawLlmCitation[] | undefined,
  chunks: readonly RetrievalCandidate[],
): SourceCitation[] {
  if (!rawCitations) return [];

  const citations: SourceCitation[] = [];

  for (const raw of rawCitations) {
    if (!raw.quote) continue;

    // Try to match by source title first, then by quote overlap
    let matchedChunk: RetrievalCandidate | undefined;

    if (raw.sourceTitle) {
      matchedChunk = chunks.find(
        (c) =>
          c.sourceTitle.toLowerCase() === raw.sourceTitle!.toLowerCase(),
      );
    }

    if (!matchedChunk && raw.quote) {
      // Fuzzy match: find chunk whose quoteText contains a significant
      // portion of the LLM's quote or vice versa
      const quoteLower = raw.quote.toLowerCase();
      matchedChunk = chunks.find((c) => {
        const chunkQuoteLower = c.quoteText.toLowerCase();
        return (
          chunkQuoteLower.includes(quoteLower.slice(0, 30)) ||
          quoteLower.includes(chunkQuoteLower.slice(0, 30))
        );
      });
    }

    if (matchedChunk) {
      citations.push({
        quote: raw.quote,
        sourceTitle: matchedChunk.sourceTitle,
        edition: matchedChunk.edition,
        language: matchedChunk.language,
        page: raw.page ?? matchedChunk.pageNumber,
        section: raw.section ?? matchedChunk.sectionHeading,
        category: matchedChunk.sourceCategory,
        fileId: matchedChunk.fileId,
        sourceId: matchedChunk.sourceId,
        chunkId: matchedChunk.chunkId,
      });
    } else {
      // Unmatched citation — still include what the LLM gave us
      citations.push({
        quote: raw.quote,
        sourceTitle: raw.sourceTitle ?? "Unknown",
        edition: raw.edition ?? "",
        language: "",
        page: raw.page ?? null,
        section: raw.section ?? null,
        category: "",
        fileId: "",
        sourceId: "",
        chunkId: "",
      });
    }
  }

  return citations;
}
