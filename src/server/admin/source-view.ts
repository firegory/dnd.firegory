import { type AdminContext } from "./admin-context";
import { ContentMetadataService, getContentMetadataDb, type SourceMetadataRecord } from "../content/metadata";

export type SourceStats = Readonly<{
  totalFiles: number;
  totalPages: number;
  totalChunks: number;
  embeddingsGenerated: number;
  embeddingsSkipped: number;
  latestJobId: string | null;
  latestJobStatus: string | null;
  latestJobStartedAt: string | null;
  latestJobFinishedAt: string | null;
}>;

export type SourceWithStats = SourceMetadataRecord & SourceStats;

type StatsRow = Readonly<{
  source_id: string;
  total_files: string | number;
  total_pages: string | number;
  total_chunks: string | number;
  embeddings_generated: string | number;
  embeddings_skipped: string | number;
  latest_job_id: string | null;
  latest_job_status: string | null;
  latest_job_started_at: Date | string | null;
  latest_job_finished_at: Date | string | null;
}>;

const EMPTY_STATS: SourceStats = {
  totalFiles: 0,
  totalPages: 0,
  totalChunks: 0,
  embeddingsGenerated: 0,
  embeddingsSkipped: 0,
  latestJobId: null,
  latestJobStatus: null,
  latestJobStartedAt: null,
  latestJobFinishedAt: null,
};

export async function listSourcesWithStats(admin: AdminContext): Promise<SourceWithStats[]> {
  const service = new ContentMetadataService();
  const sources = await service.listSources(admin);
  if (sources.length === 0) return [];
  const stats = await getStats(sources.map((source) => source.id));
  return sources.map((source) => ({ ...source, ...(stats.get(source.id) ?? EMPTY_STATS) }));
}

export async function getSourceWithStats(admin: AdminContext, sourceId: string): Promise<SourceWithStats> {
  const service = new ContentMetadataService();
  const source = await service.getSource(admin, sourceId);
  const stats = await getStats([source.id]);
  return { ...source, ...(stats.get(source.id) ?? EMPTY_STATS) };
}

export type SourceChunkPreview = Readonly<{
  id: string;
  text: string;
  quoteText: string;
  pageNumber: number | null;
  sectionHeading: string | null;
  charCount: number;
}>;

type ChunkRow = Readonly<{
  id: string;
  text: string;
  quote_text: string;
  page_number: number | null;
  section_heading: string | null;
}>;

export async function listSourceChunkPreviews(sourceId: string, limit = 5): Promise<SourceChunkPreview[]> {
  const result = await getContentMetadataDb().query<ChunkRow>(
    `SELECT id, text, quote_text, page_number, section_heading
     FROM chunks
     WHERE source_id = $1
     ORDER BY chunk_index ASC
     LIMIT $2`,
    [sourceId, limit],
  );
  return result.rows.map((row) => ({
    id: row.id,
    text: row.text,
    quoteText: row.quote_text,
    pageNumber: row.page_number,
    sectionHeading: row.section_heading,
    charCount: row.text.length,
  }));
}

async function getStats(sourceIds: readonly string[]): Promise<Map<string, SourceStats>> {
  const result = await getContentMetadataDb().query<StatsRow>(
    `WITH selected_sources AS (
       SELECT unnest($1::uuid[]) AS source_id
     ), file_counts AS (
       SELECT source_id, count(*) AS total_files
       FROM files
       WHERE deleted_at IS NULL AND source_id = ANY($1::uuid[])
       GROUP BY source_id
     ), page_counts AS (
       SELECT source_id, count(*) AS total_pages
       FROM pages
       WHERE source_id = ANY($1::uuid[])
       GROUP BY source_id
     ), chunk_counts AS (
       SELECT source_id,
              count(*) AS total_chunks,
              count(*) FILTER (WHERE embedding IS NOT NULL) AS embeddings_generated,
              count(*) FILTER (WHERE embedding IS NULL) AS embeddings_skipped
       FROM chunks
       WHERE source_id = ANY($1::uuid[])
       GROUP BY source_id
     ), latest_jobs AS (
       SELECT DISTINCT ON (source_id)
              source_id,
              id AS latest_job_id,
              status::text AS latest_job_status,
              started_at AS latest_job_started_at,
              finished_at AS latest_job_finished_at
       FROM ingestion_jobs
       WHERE source_id = ANY($1::uuid[])
       ORDER BY source_id, queued_at DESC
     )
     SELECT s.source_id,
            coalesce(f.total_files, 0) AS total_files,
            coalesce(p.total_pages, 0) AS total_pages,
            coalesce(c.total_chunks, 0) AS total_chunks,
            coalesce(c.embeddings_generated, 0) AS embeddings_generated,
            coalesce(c.embeddings_skipped, 0) AS embeddings_skipped,
            j.latest_job_id,
            j.latest_job_status,
            j.latest_job_started_at,
            j.latest_job_finished_at
     FROM selected_sources s
     LEFT JOIN file_counts f ON f.source_id = s.source_id
     LEFT JOIN page_counts p ON p.source_id = s.source_id
     LEFT JOIN chunk_counts c ON c.source_id = s.source_id
     LEFT JOIN latest_jobs j ON j.source_id = s.source_id`,
    [sourceIds],
  );

  return new Map(
    result.rows.map((row) => [
      row.source_id,
      {
        totalFiles: Number(row.total_files),
        totalPages: Number(row.total_pages),
        totalChunks: Number(row.total_chunks),
        embeddingsGenerated: Number(row.embeddings_generated),
        embeddingsSkipped: Number(row.embeddings_skipped),
        latestJobId: row.latest_job_id,
        latestJobStatus: row.latest_job_status,
        latestJobStartedAt: formatDate(row.latest_job_started_at),
        latestJobFinishedAt: formatDate(row.latest_job_finished_at),
      },
    ]),
  );
}

function formatDate(value: Date | string | null): string | null {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}
