/**
 * Hybrid retrieval: merges and deduplicates candidates from multiple strategies.
 *
 * Uses Reciprocal Rank Fusion (RRF) to combine scores from keyword and vector
 * strategies into a single ranked list. Deduplicates by chunk ID.
 */

import type { RetrievalCandidate } from "./types";

/** Configuration for the hybrid merge. */
export type HybridMergeConfig = Readonly<{
  /** RRF constant k (default 60). Higher k reduces the impact of top ranks. */
  rrfK?: number;
  /** Maximum number of merged candidates to return. */
  limit: number;
}>;

const DEFAULT_RRF_K = 60;

/**
 * Merges candidates from multiple retrieval strategies using Reciprocal Rank Fusion.
 *
 * Each strategy's candidates are ranked by their original score (descending).
 * The RRF score for each candidate is `sum(1 / (k + rank_i))` across strategies.
 * Candidates are deduplicated by chunk ID (first occurrence wins for metadata).
 *
 * This is a pure function with no external dependencies, making it easy to test.
 */
export function mergeCandidates(
  strategyResults: readonly (readonly RetrievalCandidate[])[],
  config: HybridMergeConfig,
): readonly RetrievalCandidate[] {
  const k = config.rrfK ?? DEFAULT_RRF_K;
  const limit = Math.min(Math.max(1, config.limit), 200);

  // Build rank maps per strategy
  const rrfScores = new Map<string, number>();
  const candidateMap = new Map<string, RetrievalCandidate>();

  for (const candidates of strategyResults) {
    // Sort by strategy-specific score descending to determine rank
    const sorted = [...candidates].sort((a, b) => b.score - a.score);

    for (let rank = 0; rank < sorted.length; rank++) {
      const candidate = sorted[rank];
      const { chunkId } = candidate;

      // Accumulate RRF score
      const rrfContribution = 1 / (k + rank + 1); // rank is 0-based, RRF uses 1-based
      rrfScores.set(
        chunkId,
        (rrfScores.get(chunkId) ?? 0) + rrfContribution,
      );

      // Keep first occurrence for metadata
      if (!candidateMap.has(chunkId)) {
        candidateMap.set(chunkId, candidate);
      }
    }
  }

  // Sort by RRF score descending
  const merged = [...candidateMap.entries()]
    .map(([chunkId, candidate]) => ({
      ...candidate,
      // Override score with RRF fused score
      score: rrfScores.get(chunkId) ?? 0,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return merged;
}
