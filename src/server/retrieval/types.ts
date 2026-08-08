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
  strategy: "keyword" | "vector" | "entity";
  /** Citation-backed compendium fields that caused an exact entity match. */
  entityEvidence?: readonly EntityEvidence[];
}>;

export type EntityEvidence = Readonly<{
  entryId: string;
  entryType: string;
  canonicalKey: string;
  title: string;
  citationId: string;
  citationKind: "field" | "block";
  fieldPath: string | null;
  quote: string;
}>;

/** Parameters shared across retrieval strategies. */
export type RetrievalParams = Readonly<{
  /** Maximum number of candidates to return per strategy. */
  limit: number;
  /** Authorized active generation IDs captured once for this request. */
  generationIds: readonly string[];
  /** When present, restricts retrieval to citation-backed entity chunks. */
  chunkIds?: readonly string[];
}>;
