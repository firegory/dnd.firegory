/**
 * LLM-based query rewriting for improved retrieval.
 *
 * Rewrites user queries to extract core search concepts, strip conversational
 * filler, and produce bilingual variants. Used to generate multiple embedding
 * vectors for broader recall in vector search.
 */

import { chatCompletion, type ChatMessage } from "../llm/client";

export type RewrittenQuery = Readonly<{
  /** The original user query. */
  original: string;
  /** Canonical English search form (stripped of filler). */
  canonical: string;
  /** Bilingual variants for cross-language retrieval. */
  bilingual: readonly string[];
  /** Related D&D terms and synonyms. */
  expanded: readonly string[];
}>;

const REWRITE_SYSTEM_PROMPT = `You are a D&D 5e search query optimizer. Rewrite the user's search query for semantic search.

Rules:
- Strip conversational filler ("who is", "tell me about", "how does", "what are", "can you explain")
- Extract the core D&D concept, class, spell, rule, or entity
- Keep D&D-specific terms intact (proper nouns, rule names)
- If the query is in Russian, translate to the English D&D equivalent
- If the query is in English, provide the Russian D&D translation
- List 2-4 related D&D terms that would appear in the same rulebook passages

Output ONLY valid JSON with no markdown:
{"canonical":"english search query","bilingual":["translation"],"expanded":["related term 1","related term 2"]}

Examples:
Input: "Who is monk"
Output: {"canonical":"monk class","bilingual":["монах"],"expanded":["monastic tradition","ki","martial arts","unarmored defense"]}

Input: "Монах"
Output: {"canonical":"monk class","bilingual":["монах","monk"],"expanded":["monastic tradition","ki","martial arts"]}

Input: "How does sneak attack work"
Output: {"canonical":"sneak attack rogue","bilingual":["скрытая атака"],"expanded":["rogue","surprise","advantage","finesse weapon"]}`;

const MAX_QUERY_LENGTH = 200;

const CACHE_MAX = 200;
const rewriteCache = new Map<string, RewrittenQuery>();

function cacheKey(query: string): string {
  return query.trim().toLowerCase().slice(0, MAX_QUERY_LENGTH);
}

function parseRewriteResponse(content: string, original: string): RewrittenQuery {
  let parsed: Record<string, unknown>;
  try {
    const cleaned = content.replace(/```json\s*|```\s*/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return {
      original,
      canonical: original,
      bilingual: [],
      expanded: [],
    };
  }

  const canonical = typeof parsed.canonical === "string" && parsed.canonical.trim()
    ? parsed.canonical.trim()
    : original;

  const bilingual = Array.isArray(parsed.bilingual)
    ? parsed.bilingual.filter((t): t is string =>
        typeof t === "string" && !!t.trim() && t.trim().toLowerCase() !== canonical.toLowerCase()
      )
    : [];

  const expanded = Array.isArray(parsed.expanded)
    ? parsed.expanded.filter((t): t is string => typeof t === "string" && !!t.trim())
    : [];

  return { original, canonical, bilingual, expanded };
}

/**
 * Rewrites a user query using the LLM to produce optimized search variants.
 *
 * Returns the original query unchanged if the LLM call fails, ensuring
 * graceful degradation.
 */
export async function rewriteQuery(query: string): Promise<RewrittenQuery> {
  const trimmed = query.trim();
  if (!trimmed) {
    return { original: trimmed, canonical: trimmed, bilingual: [], expanded: [] };
  }

  const key = cacheKey(trimmed);
  const cached = rewriteCache.get(key);
  if (cached) return cached;

  const messages: ChatMessage[] = [
    { role: "system", content: REWRITE_SYSTEM_PROMPT },
    { role: "user", content: trimmed.slice(0, MAX_QUERY_LENGTH) },
  ];

  try {
    const result = await chatCompletion(messages, {
      maxTokens: 200,
      temperature: 0.1,
    });

    const rewritten = parseRewriteResponse(result.content, trimmed);

    if (rewriteCache.size >= CACHE_MAX) {
      const firstKey = rewriteCache.keys().next().value;
      if (firstKey) rewriteCache.delete(firstKey);
    }
    rewriteCache.set(key, rewritten);

    return rewritten;
  } catch (error) {
    console.error("[rewrite] LLM rewrite failed:", error);
    return { original: trimmed, canonical: trimmed, bilingual: [], expanded: [] };
  }
}

/**
 * Collects all unique query texts for multi-vector embedding.
 *
 * Deduplicates case-insensitively and filters empty strings.
 */
export function collectVectorQueries(rewritten: RewrittenQuery): string[] {
  const seen = new Set<string>();
  const queries: string[] = [];

  const candidates = [
    rewritten.original,
    rewritten.canonical,
    ...rewritten.bilingual,
  ];

  for (const q of candidates) {
    const key = q.trim().toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      queries.push(q.trim());
    }
  }

  return queries;
}
