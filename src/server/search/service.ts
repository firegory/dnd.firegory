/**
 * Search service: returns authorized chunk/citation candidates.
 *
 * Generates SQL WHERE conditions directly from the RetrievalAuthorizationFilter
 * so access control is enforced at the database level without loading all sources
 * into application memory. The actual keyword/vector/hybrid search will be
 * added in issue #11.
 */

import { query } from "../db/client";
import {
  buildRetrievalAuthorizationFilter,
  type RetrievalSelection,
  type RetrievalUser,
} from "../access/retrieval-filter";
import { buildSourceAccessSql } from "../access/access-sql";

export type SearchInput = Readonly<{
  query: string;
  user: RetrievalUser;
  selection?: RetrievalSelection;
  limit?: number;
  offset?: number;
}>;

export type ChunkCitation = Readonly<{
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
}>;

export type SearchResult = Readonly<{
  chunks: readonly ChunkCitation[];
  total: number;
  hasMore: boolean;
}>;

type SourceRow = Readonly<{
  id: string;
  title: string;
  category: string;
  edition: string;
  language: string;
  access_tier: string;
  shared: boolean;
  owner_user_id: string | null;
}>;

type ChunkRow = Readonly<{
  id: string;
  source_id: string;
  file_id: string;
  text: string;
  quote_text: string;
  section_heading: string | null;
  page_number: number | null;
}>;

/**
 * Performs a full-text search across chunks, enforcing access filters at the
 * SQL level via a JOIN with filtered sources.
 *
 * This is the basic keyword search implementation. Hybrid retrieval
 * (keyword + vector + reranking) will be added in issue #11.
 */
export async function searchChunks(input: SearchInput): Promise<SearchResult> {
  const { query: searchQuery, user, selection = {}, limit = 20, offset = 0 } = input;

  if (!searchQuery.trim()) {
    return { chunks: [], total: 0, hasMore: false };
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);

  const filter = buildRetrievalAuthorizationFilter(user, selection);
  const { sql: accessSql, params: accessParams } = buildSourceAccessSql(filter);

  // $1 = search query text
  // accessParams start at $2+
  const searchParamIdx = accessParams.length + 1;
  const limitIdx = accessParams.length + 2;
  const offsetIdx = accessParams.length + 3;

  const allParams = [...accessParams, searchQuery, safeLimit, safeOffset];

  // Count query — join chunks with access-filtered sources
  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text
     FROM chunks c
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND ${accessSql}
       AND to_tsvector('simple', c.text) @@ plainto_tsquery('simple', $${searchParamIdx})`,
    allParams.slice(0, -2), // count doesn't need limit/offset
  );

  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Data query — fetch chunks with source metadata in a single query
  const chunkResult = await query<ChunkRow & SourceRow>(
    `SELECT c.id, c.source_id, c.file_id, c.text, c.quote_text, c.section_heading, c.page_number,
            s.title, s.category, s.edition, s.language, s.access_tier
     FROM chunks c
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND ${accessSql}
       AND to_tsvector('simple', c.text) @@ plainto_tsquery('simple', $${searchParamIdx})
     ORDER BY c.id
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    allParams,
  );

  const chunks: ChunkCitation[] = chunkResult.rows.map((row) => ({
    chunkId: row.id,
    sourceId: row.source_id,
    fileId: row.file_id,
    text: row.text,
    quoteText: row.quote_text,
    sectionHeading: row.section_heading,
    pageNumber: row.page_number,
    edition: row.edition,
    language: row.language,
    sourceTitle: row.title,
    sourceCategory: row.category,
    accessTier: row.access_tier,
  }));

  return {
    chunks,
    total,
    hasMore: safeOffset + safeLimit < total,
  };
}
