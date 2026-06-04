/**
 * Vector/semantic retrieval using pgvector cosine distance.
 *
 * Generates embeddings for one or more query texts, performs nearest-neighbor
 * search against the HNSW index on `chunks.embedding` for each, and merges
 * results via deduplication with best-score wins.
 *
 * Accepts either a single query string or an array for backward compatibility.
 */

import { query } from "../db/client";
import { generateEmbedding, generateEmbeddings, getQueryEmbeddingConfig } from "../embeddings/provider";
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

async function batchEmbed(queries: readonly string[]): Promise<(readonly number[] | null)[]> {
  const config = getQueryEmbeddingConfig();
  if (config.provider !== "ollama" && !config.apiKey) {
    return queries.map(() => null);
  }

  try {
    if (config.provider === "ollama" && queries.length > 1) {
      const results = await generateEmbeddings([...queries], config);
      return results.map((r) => r.embedding);
    }
    return await Promise.all(queries.map((q) => generateEmbedding(q, config).then((r) => r.embedding)));
  } catch {
    return queries.map(() => null);
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
 * Accepts a single string or an array for backward compatibility.
 * Falls back gracefully if embedding generation fails for any or all queries.
 */
export async function vectorSearch(
  searchQueries: string | readonly string[],
  params: RetrievalParams,
): Promise<readonly RetrievalCandidate[]> {
  const queries = (typeof searchQueries === "string" ? [searchQueries] : [...searchQueries])
    .map((q) => q.trim())
    .filter((q) => q.length > 0);

  const seen = new Set<string>();
  const uniqueQueries: string[] = [];
  for (const q of queries) {
    const key = q.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      uniqueQueries.push(q);
    }
  }

  if (uniqueQueries.length === 0) {
    return [];
  }

  const embeddings = await batchEmbed(uniqueQueries);

  const validEmbeddings: (readonly number[])[] = [];
  for (const emb of embeddings) {
    if (emb) validEmbeddings.push(emb);
  }

  if (validEmbeddings.length === 0) {
    return [];
  }

  const allResults = await Promise.all(
    validEmbeddings.map((emb) => searchByEmbedding(emb, params)),
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
