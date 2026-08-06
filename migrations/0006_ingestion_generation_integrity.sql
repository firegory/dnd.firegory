-- Harden generation ownership and serialize replacement jobs per file.

-- Normalize legacy ownership to the file, which has always been the canonical
-- source owner, before adding composite foreign keys.
UPDATE ingestion_jobs j
SET source_id = f.source_id
FROM files f
WHERE j.file_id = f.id AND j.source_id IS DISTINCT FROM f.source_id;

UPDATE ingestion_generations g
SET source_id = f.source_id
FROM files f
WHERE g.file_id = f.id AND g.source_id IS DISTINCT FROM f.source_id;

UPDATE documents d
SET source_id = f.source_id
FROM files f
WHERE d.file_id = f.id AND d.source_id IS DISTINCT FROM f.source_id;

UPDATE pages p
SET source_id = f.source_id
FROM files f
WHERE p.file_id = f.id AND p.source_id IS DISTINCT FROM f.source_id;

UPDATE chunks c
SET source_id = f.source_id
FROM files f
WHERE c.file_id = f.id AND c.source_id IS DISTINCT FROM f.source_id;

-- If legacy data contains multiple active jobs for one file, retain a running
-- claimant (or the oldest queued claimant) and cancel the others.
WITH duplicate_active_jobs AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY file_id
           ORDER BY (status = 'processing') DESC, queued_at, id
         ) AS position
  FROM ingestion_jobs
  WHERE file_id IS NOT NULL AND status IN ('queued', 'processing')
)
UPDATE ingestion_jobs j
SET status = 'cancelled', finished_at = now(),
    error_summary = 'Cancelled while migrating duplicate active ingestion jobs'
FROM duplicate_active_jobs d
WHERE j.id = d.id AND d.position > 1;

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_jobs_one_active_file_idx
  ON ingestion_jobs(file_id)
  WHERE file_id IS NOT NULL AND status IN ('queued', 'processing');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_id_source_unique') THEN
    ALTER TABLE files ADD CONSTRAINT files_id_source_unique UNIQUE (id, source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_jobs_id_file_source_unique') THEN
    ALTER TABLE ingestion_jobs ADD CONSTRAINT ingestion_jobs_id_file_source_unique
      UNIQUE (id, file_id, source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_generations_id_file_source_unique') THEN
    ALTER TABLE ingestion_generations ADD CONSTRAINT ingestion_generations_id_file_source_unique
      UNIQUE (id, file_id, source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_jobs_file_source_fk') THEN
    ALTER TABLE ingestion_jobs ADD CONSTRAINT ingestion_jobs_file_source_fk
      FOREIGN KEY (file_id, source_id) REFERENCES files(id, source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_generations_file_source_fk') THEN
    ALTER TABLE ingestion_generations ADD CONSTRAINT ingestion_generations_file_source_fk
      FOREIGN KEY (file_id, source_id) REFERENCES files(id, source_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ingestion_generations_job_owner_fk') THEN
    ALTER TABLE ingestion_generations ADD CONSTRAINT ingestion_generations_job_owner_fk
      FOREIGN KEY (ingestion_job_id, file_id, source_id)
      REFERENCES ingestion_jobs(id, file_id, source_id) ON DELETE SET NULL (ingestion_job_id);
  END IF;
END $$;

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_active_generation_fk;
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_generation_fk;
ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_generation_fk;
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_generation_fk;

ALTER TABLE files ADD CONSTRAINT files_active_generation_fk
  FOREIGN KEY (active_generation_id, id, source_id)
  REFERENCES ingestion_generations(id, file_id, source_id)
  DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE documents ADD CONSTRAINT documents_generation_fk
  FOREIGN KEY (generation_id, file_id, source_id)
  REFERENCES ingestion_generations(id, file_id, source_id) ON DELETE CASCADE;
ALTER TABLE pages ADD CONSTRAINT pages_generation_fk
  FOREIGN KEY (generation_id, file_id, source_id)
  REFERENCES ingestion_generations(id, file_id, source_id) ON DELETE CASCADE;
ALTER TABLE chunks ADD CONSTRAINT chunks_generation_fk
  FOREIGN KEY (generation_id, file_id, source_id)
  REFERENCES ingestion_generations(id, file_id, source_id) ON DELETE CASCADE;
