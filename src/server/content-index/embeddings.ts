import { query } from "../db/client.ts";
import { generateEmbeddings, getIngestionEmbeddingConfig } from "../embeddings/provider.ts";

export async function backfillContentIndexEmbeddings(batchSize = 20): Promise<number> {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
    throw new TypeError("batchSize must be an integer from 1 through 100");
  }
  let updated = 0;
  while (true) {
    const chunks = await query<{ id: string; text: string }>(
      `SELECT c.id, c.text
       FROM chunks c
       JOIN files f ON f.id = c.file_id AND f.active_generation_id = c.generation_id
       JOIN nfs_index_managed_files mf ON mf.file_id = c.file_id
       WHERE c.embedding IS NULL
       ORDER BY c.id
       LIMIT $1`,
      [batchSize],
    );
    if (chunks.rows.length === 0) return updated;
    const generated = await generateEmbeddings(
      chunks.rows.map((chunk) => chunk.text),
      getIngestionEmbeddingConfig(),
      batchSize,
    );
    for (const [index, chunk] of chunks.rows.entries()) {
      const embedding = generated[index];
      const result = await query(
        `UPDATE chunks SET embedding = $2::vector, embedding_model = $3,
           token_count = COALESCE($4, token_count)
         WHERE id = $1 AND embedding IS NULL`,
        [chunk.id, `[${embedding.embedding.join(",")}]`, embedding.model, embedding.tokenCount],
      );
      updated += result.rowCount ?? 0;
    }
  }
}
