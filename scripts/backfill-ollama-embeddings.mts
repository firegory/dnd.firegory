import { generateEmbeddings, getEmbeddingConfig } from "../src/server/embeddings/provider.ts";
import { query } from "../src/server/db/client.ts";

const sourceIdArg = process.argv[2];
const limitArg = process.argv[3] ? Number.parseInt(process.argv[3], 10) : null;
const batchSizeArg = process.argv[4] ? Number.parseInt(process.argv[4], 10) : 12;

if (!sourceIdArg) {
  console.error("Usage: node --experimental-strip-types scripts/backfill-ollama-embeddings.mts <source-id> [limit] [batch-size]");
  process.exit(1);
}

const batchSize = Number.isFinite(batchSizeArg) && batchSizeArg > 0 ? batchSizeArg : 12;
const limitSql = Number.isFinite(limitArg as number) && (limitArg as number) > 0 ? "LIMIT $2" : "";
const params: unknown[] = [sourceIdArg];
if (limitSql) params.push(limitArg);

const config = getEmbeddingConfig();
console.log(`[backfill] provider=${config.provider} model=${config.model} dimensions=${config.dimensions} keepAlive=${config.keepAlive || ""}`);

const initial = await query<{ total: string; missing: string }>(
  `SELECT count(*)::text AS total, count(*) FILTER (WHERE embedding IS NULL)::text AS missing FROM chunks WHERE source_id = $1`,
  [sourceIdArg],
);
console.log(`[backfill] source=${sourceIdArg} total=${initial.rows[0]?.total ?? 0} missing=${initial.rows[0]?.missing ?? 0}`);

const rowsResult = await query<{ id: string; text: string }>(
  `SELECT id, text FROM chunks WHERE source_id = $1 AND embedding IS NULL ORDER BY chunk_index ${limitSql}`,
  params,
);

const rows = rowsResult.rows;
console.log(`[backfill] selected=${rows.length} batchSize=${batchSize}`);

let done = 0;
for (let offset = 0; offset < rows.length; offset += batchSize) {
  const batch = rows.slice(offset, offset + batchSize);
  const embeddings = await generateEmbeddings(batch.map((row) => row.text), undefined, batch.length);

  await query("BEGIN");
  try {
    for (let i = 0; i < batch.length; i++) {
      const embedding = embeddings[i]?.embedding;
      if (!embedding) throw new Error(`No embedding returned for row ${batch[i].id}`);
      await query(
        `UPDATE chunks SET embedding = $2::vector, embedding_model = $3, token_count = COALESCE(token_count, $4) WHERE id = $1`,
        [batch[i].id, `[${embedding.join(",")}]`, embeddings[i].model, embeddings[i].tokenCount],
      );
    }
    await query("COMMIT");
  } catch (err) {
    await query("ROLLBACK").catch(() => undefined);
    throw err;
  }

  done += batch.length;
  if (done % (batchSize * 5) === 0 || done === rows.length) {
    console.log(`[backfill] done=${done}/${rows.length}`);
  }
}

const final = await query<{ total: string; embeddings: string; missing: string }>(
  `SELECT count(*)::text AS total, count(embedding)::text AS embeddings, count(*) FILTER (WHERE embedding IS NULL)::text AS missing FROM chunks WHERE source_id = $1`,
  [sourceIdArg],
);
console.log(`[backfill] final total=${final.rows[0]?.total ?? 0} embeddings=${final.rows[0]?.embeddings ?? 0} missing=${final.rows[0]?.missing ?? 0}`);
