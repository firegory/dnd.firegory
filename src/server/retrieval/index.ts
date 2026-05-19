/**
 * Retrieval pipeline — re-exports for public API.
 */

export { hybridSearch, type HybridSearchInput, type HybridSearchResult } from "./pipeline";
export { keywordSearch } from "./keyword";
export { vectorSearch } from "./vector";
export { mergeCandidates, type HybridMergeConfig } from "./hybrid";
export { expandQuery, combinedExpandedQuery, type ExpansionConfig, type ExpandedQuery } from "./expand";
export { rerankCandidates, noopRerankConfig, type RerankConfig } from "./rerank";
export type { RetrievalCandidate, RetrievalParams } from "./types";
