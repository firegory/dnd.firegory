/**
 * Embedding provider integration via z.ai API.
 *
 * Generates text embeddings using the z.ai API and persists them
 * into the chunks table with pgvector.
 */

import { query } from "../../server/db/client.ts";

export type EmbeddingConfig = Readonly<{
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
}>;

const DEFAULT_EMBEDDING_CONFIG: EmbeddingConfig = {
  apiKey: "",
  baseUrl: "https://api.z.ai/v1",
  model: "z-embedding",
  dimensions: 1024,
};

export type EmbeddingResult = Readonly<{
  embedding: readonly number[];
  tokenCount: number | null;
  model: string;
}>;

/**
 * Gets the embedding configuration from environment variables.
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  return {
    ...DEFAULT_EMBEDDING_CONFIG,
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseUrl: process.env.ZAI_EMBEDDING_BASE_URL ?? DEFAULT_EMBEDDING_CONFIG.baseUrl,
    model: process.env.ZAI_EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_CONFIG.model,
    dimensions: parseInt(process.env.ZAI_EMBEDDING_DIMENSIONS ?? "1024", 10),
  };
}

/**
 * Generates an embedding for a single text string.
 */
export async function generateEmbedding(
  text: string,
  config?: Partial<EmbeddingConfig>,
): Promise<EmbeddingResult> {
  const cfg = { ...getEmbeddingConfig(), ...config };

  if (!cfg.apiKey) {
    throw new Error("ZAI_API_KEY is required for embedding generation");
  }

  const response = await fetch(`${cfg.baseUrl}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      input: text,
      dimensions: cfg.dimensions,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Embedding API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const data = await response.json() as {
    data: Array<{ embedding: number[] }>;
    usage?: { prompt_tokens?: number };
    model?: string;
  };

  if (!data.data?.[0]?.embedding) {
    throw new Error("Embedding API returned no embedding data");
  }

  return {
    embedding: data.data[0].embedding,
    tokenCount: data.usage?.prompt_tokens ?? null,
    model: data.model ?? cfg.model,
  };
}

/**
 * Generates embeddings for multiple texts in a batch.
 *
 * Processes in batches to respect API rate limits.
 */
export async function generateEmbeddings(
  texts: readonly string[],
  config?: Partial<EmbeddingConfig>,
  batchSize = 20,
): Promise<EmbeddingResult[]> {
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((text) => generateEmbedding(text, config)),
    );
    results.push(...batchResults);
  }

  return results;
}

/**
 * Persists chunks with their embeddings into the database.
 *
 * Inserts into the chunks table with all required metadata including
 * the pgvector embedding column.
 */
export async function persistChunksWithEmbeddings(
  chunks: readonly Readonly<{
    sourceId: string;
    fileId: string;
    jobId: string;
    chunkIndex: number;
    text: string;
    quoteText: string;
    pageNumber: number;
    sectionHeading: string | null;
    textSpanStart: number;
    textSpanEnd: number;
    charCount: number;
    embedding: readonly number[];
    embeddingModel: string;
  }>[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  let inserted = 0;

  // Insert in batches of 10 to keep query size manageable
  for (let i = 0; i < chunks.length; i += 10) {
    const batch = chunks.slice(i, i + 10);

    for (const chunk of batch) {
      const embeddingStr = `[${chunk.embedding.join(",")}]`;

      await query(
        `INSERT INTO chunks (
          source_id, file_id, ingestion_job_id, chunk_index,
          text, quote_text, section_heading, page_number,
          text_span_start, text_span_end,
          token_count, embedding, embedding_model
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11::vector, $12)
        ON CONFLICT (file_id, chunk_index) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          ingestion_job_id = EXCLUDED.ingestion_job_id,
          text = EXCLUDED.text,
          quote_text = EXCLUDED.quote_text,
          section_heading = EXCLUDED.section_heading,
          page_number = EXCLUDED.page_number,
          text_span_start = EXCLUDED.text_span_start,
          text_span_end = EXCLUDED.text_span_end,
          embedding = EXCLUDED.embedding,
          embedding_model = EXCLUDED.embedding_model`,
        [
          chunk.sourceId,
          chunk.fileId,
          chunk.jobId,
          chunk.chunkIndex,
          chunk.text,
          chunk.quoteText,
          chunk.sectionHeading,
          chunk.pageNumber,
          chunk.textSpanStart,
          chunk.textSpanEnd,
          embeddingStr,
          chunk.embeddingModel,
        ],
      );
      inserted++;
    }
  }

  return inserted;
}

/**
 * Persists page records into the pages table.
 */
export async function persistPages(
  pages: readonly Readonly<{
    sourceId: string;
    fileId: string;
    jobId: string;
    pageNumber: number;
    text: string;
    sectionHeading: string | null;
  }>[],
): Promise<number> {
  if (pages.length === 0) return 0;

  let inserted = 0;
  for (const page of pages) {
    await query(
      `INSERT INTO pages (
        source_id, file_id, ingestion_job_id,
        page_number, section_heading, text
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        page.sourceId,
        page.fileId,
        page.jobId,
        page.pageNumber,
        page.sectionHeading,
        page.text,
      ],
    );
    inserted++;
  }

  return inserted;
}
