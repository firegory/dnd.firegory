/**
 * Reranking hook for retrieval candidates.
 *
 * Provides an interface for post-retrieval reranking. The default implementation
 * uses a simple heuristic based on score, source priority, and section heading
 * matches. Future implementations can call a dedicated reranking model.
 *
 * The reranker can be disabled entirely, in which case candidates pass through
 * in their original order.
 */

import type { RetrievalCandidate } from "./types";

/** Configuration for the reranking step. */
export type RerankConfig = Readonly<{
  /** Whether reranking is enabled. Default: true. */
  enabled?: boolean;
  /** Bonus multiplier for chunks with matching section headings (0–1). */
  sectionMatchBonus?: number;
  /** Source priority weights by category. Higher = preferred. */
  sourcePriority?: Readonly<Record<string, number>>;
}>;

const DEFAULT_CONFIG: Required<RerankConfig> = {
  enabled: true,
  sectionMatchBonus: 0.1,
  sourcePriority: {
    core_rules: 1.0,
    official_supplement: 0.9,
    homebrew: 0.7,
  },
};

/**
 * Reranks retrieval candidates using a heuristic scoring function.
 *
 * The heuristic adjusts the original score based on:
 * - Source category priority (core rules > supplements > homebrew)
 * - Section heading match bonus (if query terms appear in heading)
 *
 * This is a pure function with no external dependencies.
 *
 * Falls back to pass-through when `config.enabled` is false.
 */
export function rerankCandidates(
  candidates: readonly RetrievalCandidate[],
  searchQuery: string,
  config: RerankConfig = {},
): readonly RetrievalCandidate[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!cfg.enabled || candidates.length === 0) {
    return candidates;
  }

  const queryTerms = searchQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 2);

  const reranked = candidates.map((candidate) => {
    let adjustedScore = candidate.score;

    // Source priority adjustment
    const priority = cfg.sourcePriority[candidate.sourceCategory] ?? 0.8;
    adjustedScore *= priority;

    // Section heading match bonus
    if (candidate.sectionHeading && queryTerms.length > 0) {
      const headingLower = candidate.sectionHeading.toLowerCase();
      const matchCount = queryTerms.filter(
        (term) => headingLower.includes(term),
      ).length;
      if (matchCount > 0) {
        const matchRatio = matchCount / queryTerms.length;
        adjustedScore += cfg.sectionMatchBonus * matchRatio;
      }
    }

    return {
      ...candidate,
      score: adjustedScore,
    };
  });

  return [...reranked].sort((a, b) => b.score - a.score);
}

/**
 * Creates a no-op reranker that passes candidates through unchanged.
 */
export function noopRerankConfig(): RerankConfig {
  return { enabled: false };
}
