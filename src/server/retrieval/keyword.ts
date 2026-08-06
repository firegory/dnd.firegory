/**
 * Keyword/full-text retrieval using Postgres tsvector/tsquery.
 *
 * Uses the existing GIN index on `chunks.text` with the 'simple' text search
 * configuration. Returns ranked candidates with ts_rank scoring.
 *
 * websearch_to_tsquery is used instead of plainto_tsquery so query expansion
 * can express OR between independent aliases/translations. This matters when
 * vector search is unavailable and the user asks with fuzzy/bilingual wording.
 */

import { query } from "../db/client";
import type { RetrievalCandidate, RetrievalParams } from "./types";

/**
 * Performs a full-text keyword search against chunk text.
 *
 * Uses `websearch_to_tsquery('simple', ...)` to convert the user query into
 * a tsquery, then matches against the GIN-indexed tsvector on chunks.text.
 * Results are ranked by `ts_rank` with normalization (document length).
 */
export async function keywordSearch(
  searchQuery: string,
  params: RetrievalParams,
): Promise<readonly RetrievalCandidate[]> {
  if (!searchQuery.trim()) {
    return [];
  }

  const { limit, accessSql, accessParams } = params;
  const safeLimit = Math.min(Math.max(1, limit), 200);

  // $N = search query text (appended after access params)
  const queryIdx = accessParams.length + 1;
  const limitIdx = accessParams.length + 2;

  const sqlParams = [...accessParams, searchQuery, safeLimit];

  const result = await query<{
    id: string;
    source_id: string;
    file_id: string;
    text: string;
    quote_text: string;
    section_heading: string | null;
    page_number: number | null;
    title: string;
    category: string;
    edition: string;
    language: string;
    access_tier: string;
    rank: number;
  }>(
    `SELECT c.id, c.source_id, c.file_id, c.text, c.quote_text,
            c.section_heading, c.page_number,
            s.title, s.category, s.edition, s.language, s.access_tier,
            ts_rank(
              to_tsvector('simple', c.text),
              websearch_to_tsquery('simple', $${queryIdx}),
              1  /* normalize by document length */
            ) AS rank
     FROM chunks c
     JOIN files f ON f.id = c.file_id AND f.active_generation_id = c.generation_id
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND f.deleted_at IS NULL
       AND ${accessSql}
       AND to_tsvector('simple', c.text) @@ websearch_to_tsquery('simple', $${queryIdx})
     ORDER BY rank DESC
     LIMIT $${limitIdx}`,
    sqlParams,
  );

  return result.rows.map((row) => ({
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
    score: row.rank,
    strategy: "keyword" as const,
  }));
}
