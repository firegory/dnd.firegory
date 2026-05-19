/**
 * Shared types for the hybrid retrieval pipeline.
 */

/** A single scored candidate chunk from any retrieval strategy. */
export type RetrievalCandidate = Readonly<{
  chunkId: string;
  sourceId: string;
  fileId: string;
  text: string;
  quoteText: string;
  sectionHeading: string | null;
  pageNumber: number | null;
  edition: string;
  language: string;
  sourceTitle: string;
  sourceCategory: string;
  accessTier: string;
  /** Strategy-specific raw score (e.g. ts_rank, cosine distance). */
  score: number;
  /** Which retrieval strategy produced this candidate. */
  strategy: "keyword" | "vector";
}>;

/** Parameters shared across retrieval strategies. */
export type RetrievalParams = Readonly<{
  /** Maximum number of candidates to return per strategy. */
  limit: number;
  /** Access filter SQL fragment (references alias "s"). */
  accessSql: string;
  /** Access filter parameter values. */
  accessParams: readonly unknown[];
}>;
