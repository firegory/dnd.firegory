import { query, withTransaction } from "../db/client.ts";
import {
  createIngestionJob,
  markJobFailed,
  markJobProcessing,
  markJobSucceeded,
  updateJobProgress,
  type IngestionJobRecord,
} from "../ingestion/storage.ts";
import { enqueueJob } from "../ingestion/queue.ts";
import {
  deleteEntitiesForFile,
  persistEntities,
  listSourceFiles,
  loadChunksForFile,
} from "../entities/storage.ts";
import { extractEntities } from "../../worker/ingestion/entity-extract.ts";

export async function createEntityExtractionJob(
  sourceId: string,
  requestedByUserId: string,
): Promise<{ job: IngestionJobRecord; queueId: string }> {
  const sourceCheck = await query<{
    id: string;
    deleted_at: string | null;
  }>("SELECT id, deleted_at FROM sources WHERE id = $1", [sourceId]);
  if (sourceCheck.rows.length === 0) {
    throw new Error(`Source not found: ${sourceId}`);
  }
  if (sourceCheck.rows[0].deleted_at !== null) {
    throw new Error(`Source ${sourceId} has been deleted.`);
  }

  const activeJobs = await query<{ id: string; status: string }>(
    `SELECT id, status FROM ingestion_jobs
     WHERE source_id = $1 AND metadata @> '{"kind":"entity_extraction"}'::jsonb
       AND status IN ('queued', 'processing')`,
    [sourceId],
  );
  if (activeJobs.rows.length > 0) {
    throw new Error(
      `Entity extraction already running for source ${sourceId} (job ${activeJobs.rows[0].id}: ${activeJobs.rows[0].status})`,
    );
  }

  const job = await createIngestionJob({
    kind: "reprocess" as IngestionJobRecord["kind"],
    sourceId,
    requestedByUserId,
    metadata: { kind: "entity_extraction" },
  });

  const queueId = await enqueueJob(job.id);
  return { job, queueId };
}

export async function runEntityExtraction(jobId: string): Promise<void> {
  await markJobProcessing(jobId);

  try {
    const jobResult = await query<{
      source_id: string | null;
      file_id: string | null;
    }>("SELECT source_id, file_id FROM ingestion_jobs WHERE id = $1", [jobId]);

    const job = jobResult.rows[0];
    if (!job?.source_id) {
      await markJobFailed(jobId, "Job missing source_id");
      return;
    }

    const files = await listSourceFiles(job.source_id);
    if (files.length === 0) {
      await markJobFailed(jobId, "No files found for source");
      return;
    }

    let totalEntities = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const progress = Math.round((i / files.length) * 90);
      await updateJobProgress(jobId, progress);

      const chunks = await loadChunksForFile(file.id);
      if (chunks.length === 0) continue;

      await deleteEntitiesForFile(file.id);

      const entities = await extractEntities(
        chunks,
        job.source_id,
        file.id,
      );

      const inserted = await persistEntities(entities);
      totalEntities += inserted;

      console.log(
        `[entity-extraction] File ${file.id}: extracted ${inserted} entities from ${chunks.length} chunks`,
      );
    }

    await query(
      "UPDATE ingestion_jobs SET entity_count = $2 WHERE id = $1",
      [jobId, totalEntities],
    );

    await markJobSucceeded(jobId);
    console.log(
      `[entity-extraction] Job ${jobId} completed: ${totalEntities} total entities`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[entity-extraction] Job ${jobId} failed:`, message);
    await markJobFailed(jobId, message);
  }
}
