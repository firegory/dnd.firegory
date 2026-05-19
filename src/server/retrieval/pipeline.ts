/**
 * Hybrid retrieval pipeline orchestrator.
 *
 * Combines keyword search, vector search, semantic expansion, and reranking
 * into a single retrieval flow. Integrates with the access filter system
 * to enforce authorization at the SQL level.
 */

import {
  buildRetrievalAuthorizationFilter,
  type RetrievalUser,
  type RetrievalSelection,
} from "../access/retrieval-filter";
import { buildSourceAccessSql } from "../access/access-sql";
import { keywordSearch } from "./keyword";
import { vectorSearch } from "./vector";
import { mergeCandidates, type HybridMergeConfig } from "./hybrid";
import { expandQuery, combinedExpandedQuery, type ExpansionConfig } from "./expand";
import { rerankCandidates, type RerankConfig } from "./rerank";
import type { RetrievalCandidate, RetrievalParams } from "./types";

export type {
  RetrievalCandidate,
  RetrievalParams,
} from "./types";

export type HybridSearchInput = Readonly<{
  /** The user's search query text. */
  query: string;
  /** Authenticated user for access control. */
  user: RetrievalUser;
  /** Optional corpus selection filters. */
  selection?: RetrievalSelection;
  /** Maximum final candidates to return. */
  limit?: number;
  /** Maximum candidates per strategy (before merge). */
  strategyLimit?: number;
  /** Expansion configuration. */
  expansionConfig?: ExpansionConfig;
  /** Reranking configuration. */
  rerankConfig?: RerankConfig;
  /** Hybrid merge configuration. */
  mergeConfig?: Omit<HybridMergeConfig, "limit">;
}>;

export type HybridSearchResult = Readonly<{
  /** Final ranked and deduplicated candidates. */
  chunks: readonly RetrievalCandidate[];
  /** Total candidates before limit truncation. */
  totalMerged: number;
  /** Whether there are more candidates beyond the limit. */
  hasMore: boolean;
  /** Query expansions used (for diagnostics). */
  expansions: readonly { text: string; reason: string; weight: number }[];
}>;

/**
 * Executes the full hybrid retrieval pipeline.
 *
 * Steps:
 * 1. Build access filter from user context.
 * 2. Optionally expand the query with synonyms/aliases.
 * 3. Run keyword and vector searches in parallel.
 * 4. Merge candidates with Reciprocal Rank Fusion.
 * 5. Optionally rerank merged candidates.
 * 6. Return ranked results.
 */
export async function hybridSearch(
  input: HybridSearchInput,
): Promise<HybridSearchResult> {
  const {
    query: searchQuery,
    user,
    selection = {},
    limit = 20,
    strategyLimit = 50,
    expansionConfig,
    rerankConfig,
    mergeConfig,
  } = input;

  if (!searchQuery.trim()) {
    return { chunks: [], totalMerged: 0, hasMore: false, expansions: [] };
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);

  // 1. Build access filter
  const filter = buildRetrievalAuthorizationFilter(user, selection);
  const { sql: accessSql, params: accessParams } = buildSourceAccessSql(filter);

  const retrievalParams: RetrievalParams = {
    limit: strategyLimit,
    accessSql,
    accessParams,
  };

  // 2. Expand query
  const expansions = expandQuery(searchQuery, expansionConfig);
  const expandedQueryText = combinedExpandedQuery(expansions);

  // 3. Run both strategies in parallel
  // Keyword search uses expanded query for broader recall
  // Vector search uses original query for semantic precision
  const [keywordResults, vectorResults] = await Promise.all([
    keywordSearch(expandedQueryText, retrievalParams),
    vectorSearch(searchQuery, retrievalParams),
  ]);

  // 4. Merge with RRF
  const mergeLimit = safeLimit * 3; // Get more for reranking, then truncate
  const merged = mergeCandidates(
    [keywordResults, vectorResults],
    { ...mergeConfig, limit: mergeLimit },
  );

  // 5. Rerank
  const reranked = rerankCandidates(merged, searchQuery, rerankConfig);

  // 6. Truncate to final limit
  const totalMerged = reranked.length;
  const finalChunks = reranked.slice(0, safeLimit);

  return {
    chunks: finalChunks,
    totalMerged,
    hasMore: totalMerged > safeLimit,
    expansions: expansions.map((e) => ({
      text: e.text,
      reason: e.reason,
      weight: e.weight,
    })),
  };
}
