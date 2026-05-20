/**
 * Vector/semantic retrieval using pgvector cosine distance.
 *
 * Generates an embedding for the query text, then performs nearest-neighbor
 * search against the HNSW index on `chunks.embedding`.
 */

import { query } from "../db/client";
import { generateEmbedding, getQueryEmbeddingConfig } from "../embeddings/provider";
import type { RetrievalCandidate, RetrievalParams } from "./types";

/**
 * Performs a vector similarity search against chunk embeddings.
 *
 * Generates an embedding for the query using the configured embedding provider,
 * then finds nearest neighbors by cosine distance using the HNSW index.
 * Falls back to an empty result if embeddings are unavailable (e.g. no API key).
 */
export async function vectorSearch(
  searchQuery: string,
  params: RetrievalParams,
): Promise<readonly RetrievalCandidate[]> {
  if (!searchQuery.trim()) {
    return [];
  }

  const { limit, accessSql, accessParams } = params;
  const safeLimit = Math.min(Math.max(1, limit), 200);

  // Generate query embedding using query-specific config
  let queryEmbedding: readonly number[];
  try {
    const config = getQueryEmbeddingConfig();
    // Ollama does not require an API key; only skip when provider is z.ai
    // and no key is configured.
    if (config.provider !== "ollama" && !config.apiKey) {
      return [];
    }
    const result = await generateEmbedding(searchQuery, config);
    queryEmbedding = result.embedding;
  } catch {
    // Embedding generation failed — skip vector search gracefully
    return [];
  }

  // $N = embedding vector string, $N+1 = limit
  const embeddingIdx = accessParams.length + 1;
  const limitIdx = accessParams.length + 2;

  const sqlParams = [
    ...accessParams,
    `[${queryEmbedding.join(",")}]`,
    safeLimit,
  ];

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
    distance: number;
  }>(
    `SELECT c.id, c.source_id, c.file_id, c.text, c.quote_text,
            c.section_heading, c.page_number,
            s.title, s.category, s.edition, s.language, s.access_tier,
            (c.embedding <=> $${embeddingIdx}::vector) AS distance
     FROM chunks c
     JOIN sources s ON s.id = c.source_id
     WHERE s.deleted_at IS NULL
       AND ${accessSql}
       AND c.embedding IS NOT NULL
     ORDER BY c.embedding <=> $${embeddingIdx}::vector
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
    // Convert cosine distance to similarity score (1 - distance).
    // Higher is better, consistent with keyword ts_rank.
    score: 1 - row.distance,
    strategy: "vector" as const,
  }));
}
