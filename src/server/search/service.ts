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
import { captureRetrievalSnapshot } from "../retrieval/snapshot";
import { mapSearchChunk, type ChunkCitation, type SearchChunkRow } from "./map-chunk";

export type { ChunkCitation } from "./map-chunk";

export type SearchDependencies = Readonly<{
  captureSnapshot?: typeof captureRetrievalSnapshot;
  execute?: typeof query;
}>;

export type SearchInput = Readonly<{
  query: string;
  user: RetrievalUser;
  selection?: RetrievalSelection;
  limit?: number;
  offset?: number;
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

/**
 * Performs a full-text search across chunks, enforcing access filters at the
 * SQL level via a JOIN with filtered sources.
 *
 * This is the basic keyword search implementation. Hybrid retrieval
 * (keyword + vector + reranking) will be added in issue #11.
 */
export async function searchChunks(
  input: SearchInput,
  dependencies: SearchDependencies = {},
): Promise<SearchResult> {
  const { query: searchQuery, user, selection = {}, limit = 20, offset = 0 } = input;

  if (!searchQuery.trim()) {
    return { chunks: [], total: 0, hasMore: false };
  }

  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);

  const filter = buildRetrievalAuthorizationFilter(user, selection);
  const { sql: accessSql, params: accessParams } = buildSourceAccessSql(filter);
  const snapshot = await (dependencies.captureSnapshot ?? captureRetrievalSnapshot)(accessSql, accessParams);
  if (snapshot.generationIds.length === 0) {
    return { chunks: [], total: 0, hasMore: false };
  }

  const allParams = [snapshot.generationIds, searchQuery, safeLimit, safeOffset];

  // Count query — join chunks with access-filtered sources
  const execute = dependencies.execute ?? query;
  const countResult = await execute<{ count: string }>(
    `SELECT count(*)::text
     FROM chunks c
     JOIN files f ON f.id = c.file_id AND f.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND f.deleted_at IS NULL
       AND c.generation_id = ANY($1::uuid[])
       AND to_tsvector('simple', c.text) @@ plainto_tsquery('simple', $2)`,
    allParams.slice(0, -2), // count doesn't need limit/offset
  );

  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Data query — fetch chunks with source metadata in a single query
  const chunkResult = await execute<SearchChunkRow & SourceRow>(
    `SELECT c.id, c.source_id, c.file_id, c.text, c.quote_text, c.section_heading, c.page_number,
            s.title, s.category, s.edition, s.language, s.access_tier
     FROM chunks c
     JOIN files f ON f.id = c.file_id AND f.source_id = c.source_id
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND f.deleted_at IS NULL
       AND c.generation_id = ANY($1::uuid[])
       AND to_tsvector('simple', c.text) @@ plainto_tsquery('simple', $2)
      ORDER BY c.id
     LIMIT $3 OFFSET $4`,
    allParams,
  );

  const chunks: ChunkCitation[] = chunkResult.rows.map(mapSearchChunk);

  return {
    chunks,
    total,
    hasMore: safeOffset + safeLimit < total,
  };
}
