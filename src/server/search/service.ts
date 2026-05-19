/**
 * Search service: returns authorized chunk/citation candidates.
 *
 * Uses the retrieval authorization filter builder to enforce role-based access
 * before returning results. The actual keyword/vector/hybrid search will be
 * added in issue #11. This issue establishes the search endpoint, filter
 * enforcement, and structured response shape.
 */

import { query } from "../db/client";
import {
  buildRetrievalAuthorizationFilter,
  sourceMatchesRetrievalAuthorizationFilter,
  type RetrievalSelection,
  type RetrievalUser,
  type SourceAccessMetadata,
  type RetrievalAuthorizationFilter,
} from "../access/retrieval-filter";

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
  deleted_at: string | null;
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
 * Builds the SQL WHERE clause for access-filtered source IDs.
 */
function buildAuthorizedSourceIdsFilter(
  sourceRows: readonly SourceRow[],
  filter: RetrievalAuthorizationFilter,
): string[] {
  const authorizedIds: string[] = [];

  for (const source of sourceRows) {
    if (source.deleted_at) continue;

    const metadata: SourceAccessMetadata = buildSourceAccessMetadata(source);

    if (sourceMatchesRetrievalAuthorizationFilter(metadata, filter)) {
      authorizedIds.push(source.id);
    }
  }

  return authorizedIds;
}

function buildSourceAccessMetadata(source: SourceRow): SourceAccessMetadata {
  const base = {
    edition: source.edition as "5e" | "5.5e",
    language: source.language as "en" | "ru",
    category: source.category as "core_rules" | "official_supplement" | "homebrew",
  };

  if (source.access_tier === "open") {
    return { ...base, accessTier: "open" };
  }

  if (source.access_tier === "premium") {
    return { ...base, accessTier: "premium", shared: source.shared };
  }

  // personal
  return {
    ...base,
    accessTier: "personal",
    ownerUserId: source.owner_user_id ?? "",
  };
}

/**
 * Performs a full-text search across chunks, enforcing access filters.
 *
 * This is the basic keyword search implementation. Hybrid retrieval
 * (keyword + vector + reranking) will be added in issue #11.
 */
export async function searchChunks(input: SearchInput): Promise<SearchResult> {
  const { query: searchQuery, user, selection = {}, limit = 20, offset = 0 } = input;

  if (!searchQuery.trim()) {
    return { chunks: [], total: 0, hasMore: false };
  }

  const filter = buildRetrievalAuthorizationFilter(user, selection);

  // Fetch all non-deleted sources and filter by authorization
  const sourceResult = await query<SourceRow>(
    "SELECT id, title, category, edition, language, access_tier, shared, owner_user_id, deleted_at FROM sources WHERE deleted_at IS NULL",
  );

  const authorizedSourceIds = buildAuthorizedSourceIdsFilter(sourceResult.rows, filter);

  if (authorizedSourceIds.length === 0) {
    return { chunks: [], total: 0, hasMore: false };
  }

  // Build a source lookup map for citation metadata
  const sourceMap = new Map<string, SourceRow>();
  for (const row of sourceResult.rows) {
    sourceMap.set(row.id, row);
  }

  // Full-text search on authorized chunks
  // Using tsvector index defined in schema: chunks_text_search_idx
  const safeLimit = Math.min(Math.max(1, limit), 100);
  const safeOffset = Math.max(0, offset);

  const placeholders = authorizedSourceIds.map((_, i) => `$${i + 3}`).join(", ");

  // Count query
  const countResult = await query<{ count: string }>(
    `SELECT count(*)::text
     FROM chunks
     WHERE source_id IN (${placeholders})
       AND to_tsvector('simple', text) @@ plainto_tsquery('simple', $1)`,
    [searchQuery, safeLimit, ...authorizedSourceIds],
  );

  const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

  // Data query
  const chunkResult = await query<ChunkRow>(
    `SELECT id, source_id, file_id, text, quote_text, section_heading, page_number
     FROM chunks
     WHERE source_id IN (${placeholders})
       AND to_tsvector('simple', text) @@ plainto_tsquery('simple', $1)
     ORDER BY id
     LIMIT $2 OFFSET $${authorizedSourceIds.length + 3}`,
    [searchQuery, safeLimit, ...authorizedSourceIds, safeOffset],
  );

  const chunks: ChunkCitation[] = chunkResult.rows.map((row) => {
    const source = sourceMap.get(row.source_id);
    return {
      chunkId: row.id,
      sourceId: row.source_id,
      fileId: row.file_id,
      text: row.text,
      quoteText: row.quote_text,
      sectionHeading: row.section_heading,
      pageNumber: row.page_number,
      edition: source?.edition ?? "",
      language: source?.language ?? "",
      sourceTitle: source?.title ?? "",
      sourceCategory: source?.category ?? "",
      accessTier: source?.access_tier ?? "",
    };
  });

  return {
    chunks,
    total,
    hasMore: safeOffset + safeLimit < total,
  };
}