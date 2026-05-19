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
  type RetrievalAuthorizationFilter,
} from "../access/retrieval-filter";
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
 * Builds the SQL WHERE clause and parameters from a RetrievalAuthorizationFilter.
 *
 * This is the same logic as in search/service.ts — we replicate it here
 * to avoid importing the search service (which we're replacing/enhancing).
 */
function buildSourceAccessSql(
  filter: RetrievalAuthorizationFilter,
): { sql: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.edition) {
    params.push(filter.edition);
    conditions.push(`s.edition = $${params.length}`);
  }

  if (filter.language) {
    params.push(filter.language);
    conditions.push(`s.language = $${params.length}`);
  }

  if (filter.category) {
    params.push(filter.category);
    conditions.push(`s.category = $${params.length}`);
  }

  if (filter.access.kind === "all") {
    // Admin — no access restriction
  } else {
    const clauseSql = filter.access.clauses.map((clause) => {
      if (clause.accessTier === "open") {
        return "(s.access_tier = 'open')";
      }
      if (clause.accessTier === "premium") {
        return "(s.access_tier = 'premium' AND s.shared = true)";
      }
      // personal
      params.push(clause.ownerUserId);
      return `(s.access_tier = 'personal' AND s.owner_user_id = $${params.length})`;
    });
    conditions.push(`(${clauseSql.join(" OR ")})`);
  }

  return {
    sql: conditions.length > 0 ? conditions.join(" AND ") : "1=1",
    params,
  };
}

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
