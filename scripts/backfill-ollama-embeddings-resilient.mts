import { generateEmbeddings } from "../src/server/embeddings/provider.ts";
import { query } from "../src/server/db/client.ts";

const sourceId = process.argv[2];
const batchSize = Number.parseInt(process.argv[3] ?? "8", 10) || 8;
if (!sourceId) throw new Error("Usage: node --experimental-strip-types scripts/backfill-ollama-embeddings-resilient.mts <source-id> [batch-size]");

async function saveEmbedding(row: { id: string; text: string }, batchSizeForCall: number): Promise<boolean> {
  try {
    const [result] = await generateEmbeddings([row.text], undefined, batchSizeForCall);
    const embedding = result.embedding;
    if (!embedding.every(Number.isFinite)) throw new Error("embedding contains non-finite values");
    await query(
      `UPDATE chunks SET embedding = $2::vector, embedding_model = $3, token_count = COALESCE(token_count, $4) WHERE id = $1`,
      [row.id, `[${embedding.join(",")}]`, result.model, result.tokenCount],
    );
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`[backfill] skip id=${row.id} err=${msg}`);
    await query(`UPDATE chunks SET embedding_model = $2, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('embedding_backfill_error', $3::text) WHERE id = $1`, [row.id, "embedding_failed", msg.slice(0, 500)]);
    return false;
  }
}

const start = await query<{ total: string; embeddings: string; missing: string }>(
  `SELECT count(*)::text total, count(embedding)::text embeddings, count(*) FILTER (WHERE embedding IS NULL)::text missing FROM chunks WHERE source_id=$1`,
  [sourceId],
);
console.log(`[backfill] start total=${start.rows[0].total} embeddings=${start.rows[0].embeddings} missing=${start.rows[0].missing} batchSize=${batchSize}`);

let processed = 0;
let skipped = 0;
while (true) {
  const rows = (await query<{ id: string; text: string }>(
    `SELECT id, text FROM chunks WHERE source_id=$1 AND embedding IS NULL AND embedding_model IS DISTINCT FROM 'embedding_failed' ORDER BY chunk_index LIMIT $2`,
    [sourceId, batchSize],
  )).rows;
  if (rows.length === 0) break;

  try {
    const results = await generateEmbeddings(rows.map(r => r.text), undefined, rows.length);
    await query("BEGIN");
    try {
      for (let i = 0; i < rows.length; i++) {
        const emb = results[i].embedding;
        if (!emb.every(Number.isFinite)) throw new Error(`non-finite embedding in batch for ${rows[i].id}`);
        await query(
          `UPDATE chunks SET embedding = $2::vector, embedding_model = $3, token_count = COALESCE(token_count, $4) WHERE id = $1`,
          [rows[i].id, `[${emb.join(",")}]`, results[i].model, results[i].tokenCount],
        );
      }
      await query("COMMIT");
      processed += rows.length;
    } catch (err) {
      await query("ROLLBACK").catch(() => undefined);
      throw err;
    }
  } catch (err) {
    console.log(`[backfill] batch failed; retrying individually: ${err instanceof Error ? err.message : String(err)}`);
    for (const row of rows) {
      if (await saveEmbedding(row, 1)) processed++; else skipped++;
    }
    if (skipped > 20) throw new Error(`too many skipped chunks: ${skipped}`);
  }

  if (processed % 80 === 0 || processed < 20) {
    const now = await query<{ embeddings: string; missing: string }>(
      `SELECT count(embedding)::text embeddings, count(*) FILTER (WHERE embedding IS NULL)::text missing FROM chunks WHERE source_id=$1`,
      [sourceId],
    );
    console.log(`[backfill] processed=${processed} db_embeddings=${now.rows[0].embeddings} missing=${now.rows[0].missing} skipped=${skipped}`);
  }
}

const final = await query<{ total: string; embeddings: string; missing: string }>(
  `SELECT count(*)::text total, count(embedding)::text embeddings, count(*) FILTER (WHERE embedding IS NULL)::text missing FROM chunks WHERE source_id=$1`,
  [sourceId],
);
console.log(`[backfill] final total=${final.rows[0].total} embeddings=${final.rows[0].embeddings} missing=${final.rows[0].missing} skipped=${skipped}`);
