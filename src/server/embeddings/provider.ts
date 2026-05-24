/**
 * Embedding provider integration.
 *
 * Generates text embeddings using either z.ai or Ollama and persists them
 * into the chunks table with pgvector.
 */

import { query } from "../../server/db/client.ts";
import type { ChunkBbox } from "../../worker/ingestion/bbox.ts";

export type EmbeddingProvider = "zai" | "ollama";

export type EmbeddingConfig = Readonly<{
  provider: EmbeddingProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  keepAlive: string;
}>;

const DEFAULT_ZAI_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "zai",
  apiKey: "",
  baseUrl: "https://api.z.ai/api/paas/v4",
  model: "z-embedding",
  dimensions: 1024,
  keepAlive: "",
};

const DEFAULT_OLLAMA_EMBEDDING_CONFIG: EmbeddingConfig = {
  provider: "ollama",
  apiKey: "",
  baseUrl: "http://127.0.0.1:11434",
  model: "bge-m3",
  dimensions: 1024,
  keepAlive: "1m",
};

export type EmbeddingResult = Readonly<{
  embedding: readonly number[];
  tokenCount: number | null;
  model: string;
}>;

function parseEmbeddingProvider(value: string | undefined): EmbeddingProvider {
  if (!value) return "zai";
  if (value === "zai" || value === "ollama") return value;
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${value}`);
}

function parseDimensions(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const dimensions = parseInt(value, 10);
  if (!Number.isFinite(dimensions) || dimensions <= 0) {
    throw new Error(`Invalid embedding dimensions: ${value}`);
  }
  return dimensions;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Gets the generic (legacy) embedding configuration from environment variables.
 *
 * Used as a fallback when neither ingestion- nor query-specific config is set.
 */
export function getEmbeddingConfig(): EmbeddingConfig {
  const provider = parseEmbeddingProvider(process.env.EMBEDDING_PROVIDER);

  if (provider === "ollama") {
    return {
      ...DEFAULT_OLLAMA_EMBEDDING_CONFIG,
      baseUrl: trimTrailingSlash(
        process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.baseUrl,
      ),
      model: process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.model,
      dimensions: parseDimensions(
        process.env.OLLAMA_EMBEDDING_DIMENSIONS ?? process.env.EMBEDDING_DIMENSIONS,
        DEFAULT_OLLAMA_EMBEDDING_CONFIG.dimensions,
      ),
      keepAlive: process.env.OLLAMA_KEEP_ALIVE ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.keepAlive,
    };
  }

  return {
    ...DEFAULT_ZAI_EMBEDDING_CONFIG,
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseUrl: trimTrailingSlash(
      process.env.ZAI_EMBEDDING_BASE_URL ?? DEFAULT_ZAI_EMBEDDING_CONFIG.baseUrl,
    ),
    model: process.env.ZAI_EMBEDDING_MODEL ?? DEFAULT_ZAI_EMBEDDING_CONFIG.model,
    dimensions: parseDimensions(
      process.env.ZAI_EMBEDDING_DIMENSIONS ?? process.env.EMBEDDING_DIMENSIONS,
      DEFAULT_ZAI_EMBEDDING_CONFIG.dimensions,
    ),
  };
}

/**
 * Gets the embedding configuration for ingestion (worker/pipeline).
 *
 * Uses INGESTION_EMBEDDING_* env vars with fallback to the generic
 * EMBEDDING_PROVIDER / OLLAMA_* / ZAI_EMBEDDING_* vars.
 *
 * This is used when generating embeddings during PDF upload/processing
 * (e.g. on a remote Ollama instance on the developer's PC).
 */
export function getIngestionEmbeddingConfig(): EmbeddingConfig {
  const provider = parseEmbeddingProvider(
    process.env.INGESTION_EMBEDDING_PROVIDER ?? process.env.EMBEDDING_PROVIDER,
  );

  if (provider === "ollama") {
    return {
      ...DEFAULT_OLLAMA_EMBEDDING_CONFIG,
      baseUrl: trimTrailingSlash(
        process.env.INGESTION_OLLAMA_BASE_URL
          ?? process.env.OLLAMA_BASE_URL
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.baseUrl,
      ),
      model:
        process.env.INGESTION_OLLAMA_EMBEDDING_MODEL
          ?? process.env.OLLAMA_EMBEDDING_MODEL
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.model,
      dimensions: parseDimensions(
        process.env.INGESTION_OLLAMA_EMBEDDING_DIMENSIONS
          ?? process.env.OLLAMA_EMBEDDING_DIMENSIONS
          ?? process.env.EMBEDDING_DIMENSIONS,
        DEFAULT_OLLAMA_EMBEDDING_CONFIG.dimensions,
      ),
      keepAlive:
        process.env.INGESTION_OLLAMA_KEEP_ALIVE
          ?? process.env.OLLAMA_KEEP_ALIVE
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.keepAlive,
    };
  }

  return {
    ...DEFAULT_ZAI_EMBEDDING_CONFIG,
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseUrl: trimTrailingSlash(
      process.env.INGESTION_ZAI_EMBEDDING_BASE_URL
        ?? process.env.ZAI_EMBEDDING_BASE_URL
        ?? DEFAULT_ZAI_EMBEDDING_CONFIG.baseUrl,
    ),
    model:
      process.env.INGESTION_ZAI_EMBEDDING_MODEL
        ?? process.env.ZAI_EMBEDDING_MODEL
        ?? DEFAULT_ZAI_EMBEDDING_CONFIG.model,
    dimensions: parseDimensions(
      process.env.INGESTION_ZAI_EMBEDDING_DIMENSIONS
        ?? process.env.ZAI_EMBEDDING_DIMENSIONS
        ?? process.env.EMBEDDING_DIMENSIONS,
      DEFAULT_ZAI_EMBEDDING_CONFIG.dimensions,
    ),
  };
}

/**
 * Gets the embedding configuration for query-time search (vector retrieval).
 *
 * Uses QUERY_EMBEDDING_* env vars with fallback to the generic
 * EMBEDDING_PROVIDER / OLLAMA_* / ZAI_EMBEDDING_* vars.
 *
 * This is used when generating embeddings for search queries
 * (e.g. on a local Ollama instance on the deploy server).
 */
export function getQueryEmbeddingConfig(): EmbeddingConfig {
  const provider = parseEmbeddingProvider(
    process.env.QUERY_EMBEDDING_PROVIDER ?? process.env.EMBEDDING_PROVIDER,
  );

  if (provider === "ollama") {
    return {
      ...DEFAULT_OLLAMA_EMBEDDING_CONFIG,
      baseUrl: trimTrailingSlash(
        process.env.QUERY_OLLAMA_BASE_URL
          ?? process.env.OLLAMA_BASE_URL
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.baseUrl,
      ),
      model:
        process.env.QUERY_OLLAMA_EMBEDDING_MODEL
          ?? process.env.OLLAMA_EMBEDDING_MODEL
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.model,
      dimensions: parseDimensions(
        process.env.QUERY_OLLAMA_EMBEDDING_DIMENSIONS
          ?? process.env.OLLAMA_EMBEDDING_DIMENSIONS
          ?? process.env.EMBEDDING_DIMENSIONS,
        DEFAULT_OLLAMA_EMBEDDING_CONFIG.dimensions,
      ),
      keepAlive:
        process.env.QUERY_OLLAMA_KEEP_ALIVE
          ?? process.env.OLLAMA_KEEP_ALIVE
          ?? DEFAULT_OLLAMA_EMBEDDING_CONFIG.keepAlive,
    };
  }

  return {
    ...DEFAULT_ZAI_EMBEDDING_CONFIG,
    apiKey: process.env.ZAI_API_KEY ?? "",
    baseUrl: trimTrailingSlash(
      process.env.QUERY_ZAI_EMBEDDING_BASE_URL
        ?? process.env.ZAI_EMBEDDING_BASE_URL
        ?? DEFAULT_ZAI_EMBEDDING_CONFIG.baseUrl,
    ),
    model:
      process.env.QUERY_ZAI_EMBEDDING_MODEL
        ?? process.env.ZAI_EMBEDDING_MODEL
        ?? DEFAULT_ZAI_EMBEDDING_CONFIG.model,
    dimensions: parseDimensions(
      process.env.QUERY_ZAI_EMBEDDING_DIMENSIONS
        ?? process.env.ZAI_EMBEDDING_DIMENSIONS
        ?? process.env.EMBEDDING_DIMENSIONS,
      DEFAULT_ZAI_EMBEDDING_CONFIG.dimensions,
    ),
  };
}

function assertEmbeddingDimensions(embedding: readonly number[], cfg: EmbeddingConfig): void {
  if (embedding.length !== cfg.dimensions) {
    throw new Error(
      `Embedding dimension mismatch for ${cfg.provider}/${cfg.model}: expected ${cfg.dimensions}, got ${embedding.length}`,
    );
  }
}

async function generateZaiEmbedding(text: string, cfg: EmbeddingConfig): Promise<EmbeddingResult> {
  if (!cfg.apiKey) {
    throw new Error("ZAI_API_KEY is required for z.ai embedding generation");
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

  const embedding = data.data?.[0]?.embedding;
  if (!embedding) {
    throw new Error("Embedding API returned no embedding data");
  }

  assertEmbeddingDimensions(embedding, cfg);

  return {
    embedding,
    tokenCount: data.usage?.prompt_tokens ?? null,
    model: data.model ?? cfg.model,
  };
}

async function generateOllamaEmbeddings(
  texts: readonly string[],
  cfg: EmbeddingConfig,
): Promise<EmbeddingResult[]> {
  const requestBody: Record<string, unknown> = {
    model: cfg.model,
    input: texts.length === 1 ? texts[0] : texts,
  };

  if (cfg.keepAlive) {
    requestBody.keep_alive = cfg.keepAlive;
  }

  const response = await fetch(`${cfg.baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Ollama embedding API error: ${response.status} ${response.statusText}${body ? ` — ${body}` : ""}`,
    );
  }

  const data = await response.json() as {
    embeddings?: number[][];
    model?: string;
    prompt_eval_count?: number;
  };

  if (!data.embeddings || data.embeddings.length !== texts.length) {
    throw new Error("Ollama embedding API returned unexpected embedding data");
  }

  return data.embeddings.map((embedding) => {
    assertEmbeddingDimensions(embedding, cfg);
    return {
      embedding,
      tokenCount: data.prompt_eval_count ?? null,
      model: data.model ?? cfg.model,
    };
  });
}

/**
 * Generates an embedding for a single text string.
 */
export async function generateEmbedding(
  text: string,
  config?: Partial<EmbeddingConfig>,
): Promise<EmbeddingResult> {
  const cfg = { ...getEmbeddingConfig(), ...config };

  if (cfg.provider === "ollama") {
    const [result] = await generateOllamaEmbeddings([text], cfg);
    return result;
  }

  return generateZaiEmbedding(text, cfg);
}

/**
 * Generates embeddings for multiple texts in a batch.
 *
 * Processes in batches to respect API rate limits and local model memory usage.
 */
export async function generateEmbeddings(
  texts: readonly string[],
  config?: Partial<EmbeddingConfig>,
  batchSize = 20,
): Promise<EmbeddingResult[]> {
  const cfg = { ...getEmbeddingConfig(), ...config };
  const results: EmbeddingResult[] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    if (cfg.provider === "ollama") {
      results.push(...await generateOllamaEmbeddings(batch, cfg));
    } else {
      const batchResults = await Promise.all(
        batch.map((text) => generateZaiEmbedding(text, cfg)),
      );
      results.push(...batchResults);
    }
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
    bbox?: ChunkBbox | null;
  }>[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  const BATCH_SIZE = 25;
  let totalInserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const valueGroups: string[] = [];
    const params: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const base = j * 13;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, NULL, $${base + 11}::vector, $${base + 12}, $${base + 13}::jsonb)`,
      );
      params.push(
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
        `[${chunk.embedding.join(",")}]`,
        chunk.embeddingModel,
        chunk.bbox ? JSON.stringify(chunk.bbox) : null,
      );
    }

    const sql = `INSERT INTO chunks (
          source_id, file_id, ingestion_job_id, chunk_index,
          text, quote_text, section_heading, page_number,
          text_span_start, text_span_end,
          token_count, embedding, embedding_model, bbox
        ) VALUES ${valueGroups.join(", ")}
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
          embedding_model = EXCLUDED.embedding_model,
          bbox = EXCLUDED.bbox`;

    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
}

/**
 * Persists chunks without embeddings into the database.
 *
 * Used when embedding generation fails or is not configured.
 * Chunks are still persisted for full-text keyword search.
 */
export async function persistChunksWithoutEmbeddings(
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
    bbox?: ChunkBbox | null;
  }>[],
): Promise<number> {
  if (chunks.length === 0) return 0;

  const BATCH_SIZE = 25;
  let totalInserted = 0;

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    const valueGroups: string[] = [];
    const params: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const chunk = batch[j];
      const base = j * 11;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10}, $${base + 11}::jsonb)`,
      );
      params.push(
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
        chunk.bbox ? JSON.stringify(chunk.bbox) : null,
      );
    }

    const sql = `INSERT INTO chunks (
          source_id, file_id, ingestion_job_id, chunk_index,
          text, quote_text, section_heading, page_number,
          text_span_start, text_span_end, bbox
        ) VALUES ${valueGroups.join(", ")}
        ON CONFLICT (file_id, chunk_index) DO UPDATE SET
          source_id = EXCLUDED.source_id,
          ingestion_job_id = EXCLUDED.ingestion_job_id,
          text = EXCLUDED.text,
          quote_text = EXCLUDED.quote_text,
          section_heading = EXCLUDED.section_heading,
          page_number = EXCLUDED.page_number,
          text_span_start = EXCLUDED.text_span_start,
          text_span_end = EXCLUDED.text_span_end,
          bbox = EXCLUDED.bbox`;

    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
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

  const BATCH_SIZE = 25;
  let totalInserted = 0;

  for (let i = 0; i < pages.length; i += BATCH_SIZE) {
    const batch = pages.slice(i, i + BATCH_SIZE);

    const valueGroups: string[] = [];
    const params: unknown[] = [];

    for (let j = 0; j < batch.length; j++) {
      const page = batch[j];
      const base = j * 6;
      valueGroups.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`,
      );
      params.push(
        page.sourceId,
        page.fileId,
        page.jobId,
        page.pageNumber,
        page.sectionHeading,
        page.text,
      );
    }

    const sql = `INSERT INTO pages (
        source_id, file_id, ingestion_job_id,
        page_number, section_heading, text
      ) VALUES ${valueGroups.join(", ")}
      ON CONFLICT (file_id, page_number) DO UPDATE SET
        source_id = EXCLUDED.source_id,
        ingestion_job_id = EXCLUDED.ingestion_job_id,
        section_heading = EXCLUDED.section_heading,
        text = EXCLUDED.text`;

    await query(sql, params);
    totalInserted += batch.length;
  }

  return totalInserted;
}
