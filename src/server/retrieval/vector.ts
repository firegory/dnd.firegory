/**
 * Vector/semantic retrieval using pgvector cosine distance.
 *
 * Generates embeddings for one or more query texts, performs nearest-neighbor
 * search against the HNSW index on `chunks.embedding` for each, and merges
 * results via deduplication with best-score wins.
 */

import { query } from "../db/client";
import { generateEmbedding, getQueryEmbeddingConfig } from "../embeddings/provider";
import type { RetrievalCandidate, RetrievalParams } from "./types";

type VectorRow = {
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
};

function rowToCandidate(row: VectorRow): RetrievalCandidate {
  return {
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
    score: 1 - row.distance,
    strategy: "vector" as const,
  };
}

async function embedQuery(searchQuery: string): Promise<readonly number[] | null> {
  const config = getQueryEmbeddingConfig();
  if (config.provider !== "ollama" && !config.apiKey) {
    return null;
  }
  try {
    const result = await generateEmbedding(searchQuery, config);
    return result.embedding;
  } catch {
    return null;
  }
}

async function searchByEmbedding(
  embedding: readonly number[],
  params: RetrievalParams,
): Promise<readonly RetrievalCandidate[]> {
  const { limit, accessSql, accessParams } = params;
  const safeLimit = Math.min(Math.max(1, limit), 200);

  const embeddingIdx = accessParams.length + 1;
  const limitIdx = accessParams.length + 2;

  const sqlParams = [
    ...accessParams,
    `[${embedding.join(",")}]`,
    safeLimit,
  ];

  const result = await query<VectorRow>(
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

  return result.rows.map(rowToCandidate);
}

/**
 * Performs vector similarity search with multiple query variants.
 *
 * For each non-empty query text, generates an embedding and runs a nearest-
 * neighbor search. Results are merged by chunkId, keeping the best (highest)
 * score per chunk across all query variants.
 *
 * Falls back gracefully if embedding generation fails for any or all queries.
 */
export async function vectorSearch(
  searchQueries: readonly string[],
  params: RetrievalParams,
): Promise<readonly RetrievalCandidate[]> {
  const uniqueQueries = [...new Set(
    searchQueries
      .map((q) => q.trim())
      .filter((q) => q.length > 0),
  )];

  if (uniqueQueries.length === 0) {
    return [];
  }

  const embeddings = await Promise.all(uniqueQueries.map(embedQuery));

  const validPairs: [string, readonly number[]][] = [];
  for (let i = 0; i < embeddings.length; i++) {
    const emb = embeddings[i];
    if (emb) {
      validPairs.push([uniqueQueries[i], emb]);
    }
  }

  if (validPairs.length === 0) {
    return [];
  }

  const allResults = await Promise.all(
    validPairs.map(([, emb]) => searchByEmbedding(emb, params)),
  );

  if (allResults.length === 1) {
    return allResults[0];
  }

  const best = new Map<string, RetrievalCandidate>();
  for (const candidates of allResults) {
    for (const candidate of candidates) {
      const existing = best.get(candidate.chunkId);
      if (!existing || candidate.score > existing.score) {
        best.set(candidate.chunkId, candidate);
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}
