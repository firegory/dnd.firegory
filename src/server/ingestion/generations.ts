import { rm } from "node:fs/promises";

import type { PoolClient, QueryResult, QueryResultRow } from "pg";

import { query, withTransaction } from "../db/client.ts";

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}>;

type GenerationRow = Readonly<{
  id: string;
  source_id: string;
  file_id: string;
  ingestion_job_id: string | null;
  status: "staged" | "active" | "archived";
  artifacts_root: string | null;
}>;

export type IngestionGeneration = Readonly<{
  id: string;
  sourceId: string;
  fileId: string;
  jobId: string | null;
  status: "staged" | "active" | "archived";
  artifactsRoot: string | null;
}>;

function generationFromRow(row: GenerationRow): IngestionGeneration {
  return {
    id: row.id,
    sourceId: row.source_id,
    fileId: row.file_id,
    jobId: row.ingestion_job_id,
    status: row.status,
    artifactsRoot: row.artifacts_root,
  };
}

export async function createStagedGeneration(input: Readonly<{
  sourceId: string;
  fileId: string;
  jobId: string;
  artifactsRoot: string;
  client?: Queryable;
}>): Promise<IngestionGeneration> {
  const db = input.client ?? { query };
  const inserted = await db.query<GenerationRow>(
    `INSERT INTO ingestion_generations
       (source_id, file_id, ingestion_job_id, status, artifacts_root)
     VALUES ($1, $2, $3, 'staged', $4)
     ON CONFLICT (ingestion_job_id) DO NOTHING
     RETURNING id, source_id, file_id, ingestion_job_id, status, artifacts_root`,
    [input.sourceId, input.fileId, input.jobId, input.artifactsRoot],
  );
  const result = inserted.rows[0] ?? (await db.query<GenerationRow>(
    `SELECT id, source_id, file_id, ingestion_job_id, status, artifacts_root
     FROM ingestion_generations WHERE ingestion_job_id = $1`,
    [input.jobId],
  )).rows[0];

  if (!result
    || result.source_id !== input.sourceId
    || result.file_id !== input.fileId
    || result.status !== "staged"
    || result.artifacts_root !== input.artifactsRoot) {
    throw new Error(`Job ${input.jobId} does not own a matching staged ingestion generation`);
  }
  return generationFromRow(result);
}

export async function activateGeneration(
  generationId: string,
  clientFactory: typeof withTransaction = withTransaction,
): Promise<void> {
  await clientFactory(async (client: PoolClient) => {
    const staged = await client.query<GenerationRow & { job_status: string }>(
      `SELECT g.id, g.source_id, g.file_id, g.ingestion_job_id, g.status,
              g.artifacts_root, j.status AS job_status
       FROM ingestion_generations g
       JOIN ingestion_jobs j ON j.id = g.ingestion_job_id
       WHERE g.id = $1
       FOR UPDATE OF g, j`,
      [generationId],
    );
    const generation = staged.rows[0];
    if (!generation || generation.status !== "staged" || generation.job_status !== "processing") {
      throw new Error(`Generation ${generationId} is not staged for a processing job`);
    }

    const file = await client.query<{ active_generation_id: string | null }>(
      "SELECT active_generation_id FROM files WHERE id = $1 FOR UPDATE",
      [generation.file_id],
    );
    if (!file.rows[0]) throw new Error(`File ${generation.file_id} not found during activation`);

    if (file.rows[0].active_generation_id) {
      await client.query(
        `UPDATE ingestion_generations
         SET status = 'archived', archived_at = now()
         WHERE id = $1 AND status = 'active'`,
        [file.rows[0].active_generation_id],
      );
    }
    await client.query(
      `UPDATE ingestion_generations
       SET status = 'active', activated_at = now()
       WHERE id = $1 AND status = 'staged'`,
      [generationId],
    );
    await client.query(
      `UPDATE files
       SET active_generation_id = $2, processed_artifacts_root = $3
       WHERE id = $1`,
      [generation.file_id, generationId, generation.artifacts_root],
    );
    await client.query(
      `UPDATE ingestion_jobs
       SET status = 'succeeded', finished_at = now(), progress = 100,
           artifacts_root = $2
       WHERE id = $1 AND status = 'processing'`,
      [generation.ingestion_job_id, generation.artifacts_root],
    );
  });
}

export async function discardStagedGeneration(
  generationId: string,
  artifactsRoot: string,
  dependencies: Readonly<{
    execute?: typeof query;
    remove?: typeof rm;
  }> = {},
): Promise<void> {
  await (dependencies.execute ?? query)(
    "DELETE FROM ingestion_generations WHERE id = $1 AND status = 'staged'",
    [generationId],
  );
  await (dependencies.remove ?? rm)(artifactsRoot, { recursive: true, force: true });
}

export async function cleanupStaleGenerations(
  fileId: string,
  currentJobId: string,
  dependencies: Readonly<{
    execute?: typeof query;
    remove?: typeof rm;
  }> = {},
): Promise<number> {
  const result = await (dependencies.execute ?? query)<{ artifacts_root: string | null }>(
    `DELETE FROM ingestion_generations g
     USING ingestion_jobs j
     WHERE g.ingestion_job_id = j.id
       AND g.file_id = $1
       AND g.ingestion_job_id <> $2
       AND g.status = 'staged'
       AND j.status IN ('failed', 'cancelled')
     RETURNING g.artifacts_root`,
    [fileId, currentJobId],
  );

  for (const row of result.rows) {
    if (!row.artifacts_root) continue;
    try {
      await (dependencies.remove ?? rm)(row.artifacts_root, { recursive: true, force: true });
    } catch (error) {
      console.error(
        `[pipeline] Failed to remove stale generation artifacts at ${row.artifacts_root}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }
  return result.rows.length;
}
