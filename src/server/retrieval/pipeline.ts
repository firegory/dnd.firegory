/**
 * Hybrid retrieval pipeline orchestrator.
 *
 * Combines keyword search, vector search, semantic expansion, query rewriting,
 * and reranking into a single retrieval flow. Integrates with the access filter
 * system to enforce authorization at the SQL level.
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
import { rewriteQuery, collectVectorQueries, type RewrittenQuery } from "./rewrite";
import { rerankCandidates, type RerankConfig } from "./rerank";
import type { RetrievalCandidate, RetrievalParams } from "./types";
import { captureRetrievalSnapshot, type RetrievalSnapshot } from "./snapshot";
import {
  enrichRewriteWithEntities,
  resolveCompendiumEntities,
  type CompendiumEntryScope,
  type EntityResolution,
  type ExactEntityMatch,
} from "./entity";

export type {
  RetrievalCandidate,
  RetrievalParams,
} from "./types";

export type { RewrittenQuery } from "./rewrite";

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
  /** Whether to enable LLM query rewriting. Default: true. */
  rewriteEnabled?: boolean;
  /** Canonical compendium entry scope for ask-about-entry requests. */
  entryScope?: CompendiumEntryScope;
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
  /**
   * LLM rewrite result. Null when rewriting is disabled.
   * When the LLM call fails, contains a fallback with original query
   * as canonical and empty bilingual/expanded arrays.
   */
  rewrite: RewrittenQuery | null;
  /** Authorized exact matches only; safe for diagnostics. */
  entityMatches: readonly ExactEntityMatch[];
}>;

export type HybridSearchDependencies = Readonly<{
  captureSnapshot?: (accessSql: string, accessParams: readonly unknown[]) => Promise<RetrievalSnapshot>;
  keyword?: typeof keywordSearch;
  vector?: typeof vectorSearch;
  resolveEntities?: typeof resolveCompendiumEntities;
  rewrite?: typeof rewriteQuery;
}>;

type RewriteOutput = {
  rewrite: RewrittenQuery;
  vectorQueries: string[];
};

/**
 * Executes the full hybrid retrieval pipeline.
 *
 * Steps:
 * 1. Build access filter from user context.
 * 2. Expand query with static glossary for keyword search.
 * 3. Rewrite query via LLM for improved vector search.
 * 4. Run keyword and multi-vector searches in parallel.
 * 5. Merge candidates with Reciprocal Rank Fusion.
 * 6. Optionally rerank merged candidates.
 * 7. Return ranked results.
 */
export async function hybridSearch(
  input: HybridSearchInput,
  dependencies: HybridSearchDependencies = {},
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
    rewriteEnabled = true,
    entryScope,
  } = input;

  if (!searchQuery.trim()) {
    return { chunks: [], totalMerged: 0, hasMore: false, expansions: [], rewrite: null, entityMatches: [] };
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);

  // 1. Build access filter
  const filter = buildRetrievalAuthorizationFilter(user, selection);
  const { sql: accessSql, params: accessParams } = buildSourceAccessSql(filter);
  const snapshot = await (dependencies.captureSnapshot ?? captureRetrievalSnapshot)(accessSql, accessParams);

  // Entity resolution uses only the fixed authorized snapshot and completes
  // before any entity names can influence expansion or semantic retrieval.
  const entityResolution: EntityResolution = await (dependencies.resolveEntities ?? resolveCompendiumEntities)(
    searchQuery,
    snapshot.generationIds,
    entryScope,
  );

  const retrievalParams: RetrievalParams = {
    limit: strategyLimit,
    generationIds: snapshot.generationIds,
    ...(entryScope ? { chunkIds: entityResolution.candidates.map((candidate) => candidate.chunkId) } : {}),
  };

  // 2. Expand query (static glossary for keyword search)
  const expansions = expandQuery(searchQuery, expansionConfig);
  const expandedQueryText = combinedExpandedQuery(expansions);

  // 3. Rewrite query via LLM (parallel with keyword search)
  const rewritePromise: Promise<RewriteOutput> = rewriteEnabled
    ? (dependencies.rewrite ?? rewriteQuery)(searchQuery).then((rawRewrite) => {
        const rewrite = enrichRewriteWithEntities(rawRewrite, entityResolution.matches);
        return {
          rewrite,
          vectorQueries: collectVectorQueries(rewrite),
        };
      })
    : Promise.resolve({
        rewrite: { original: searchQuery, canonical: searchQuery, bilingual: [], expanded: [] },
        vectorQueries: [searchQuery],
      });

  // 4. Run keyword search in parallel with LLM rewrite + vector search
  const entityQueryTerms = entityResolution.matches.flatMap((match) => [match.title, ...match.aliases]);
  const entityExpandedQuery = entityQueryTerms.length > 0
    ? `${expandedQueryText} OR ${entityQueryTerms.map((term) => `"${term.replaceAll('"', '')}"`).join(" OR ")}`
    : expandedQueryText;
  const [keywordResults, vectorResults] = await Promise.all([
    (dependencies.keyword ?? keywordSearch)(entityExpandedQuery, retrievalParams),
    rewritePromise.then(({ vectorQueries }) => (dependencies.vector ?? vectorSearch)(vectorQueries, retrievalParams)),
  ]);

  const { rewrite } = await rewritePromise;

  // 5. Merge with RRF
  const mergeLimit = safeLimit * 3;
  const merged = mergeCandidates(
    [entityResolution.candidates, keywordResults, vectorResults],
    { ...mergeConfig, limit: mergeLimit },
  );

  // 6. Rerank
  const reranked = rerankCandidates(merged, searchQuery, rerankConfig);

  // 7. Truncate to final limit
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
    rewrite: rewriteEnabled ? rewrite : null,
    entityMatches: entityResolution.matches,
  };
}
