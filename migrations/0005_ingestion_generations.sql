-- Immutable ingestion generations. Existing content is assigned to one active
-- legacy generation per file without changing page or chunk identifiers.

CREATE TABLE IF NOT EXISTS ingestion_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  ingestion_job_id uuid UNIQUE REFERENCES ingestion_jobs(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'staged',
  artifacts_root text,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  archived_at timestamptz,
  CONSTRAINT ingestion_generations_status_valid
    CHECK (status IN ('staged', 'active', 'archived')),
  CONSTRAINT ingestion_generations_status_timestamps CHECK (
    (status = 'staged' AND activated_at IS NULL AND archived_at IS NULL)
    OR (status = 'active' AND activated_at IS NOT NULL AND archived_at IS NULL)
    OR (status = 'archived' AND activated_at IS NOT NULL AND archived_at IS NOT NULL)
  ),
  CONSTRAINT ingestion_generations_artifacts_root_not_blank
    CHECK (artifacts_root IS NULL OR btrim(artifacts_root) <> ''),
  UNIQUE (id, file_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ingestion_generations_one_active_file_idx
  ON ingestion_generations(file_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ingestion_generations_source_idx
  ON ingestion_generations(source_id, created_at DESC);

ALTER TABLE files ADD COLUMN IF NOT EXISTS active_generation_id uuid;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS generation_id uuid;
ALTER TABLE pages ADD COLUMN IF NOT EXISTS generation_id uuid;
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS generation_id uuid;

-- Files are migrated even when they have no extracted rows, so every existing
-- file has a coherent active legacy generation after the migration.
INSERT INTO ingestion_generations (source_id, file_id, status, artifacts_root, activated_at)
SELECT f.source_id, f.id, 'active', f.processed_artifacts_root, f.created_at
FROM files f
WHERE NOT EXISTS (
  SELECT 1 FROM ingestion_generations g WHERE g.file_id = f.id AND g.status = 'active'
);

UPDATE files f
SET active_generation_id = g.id
FROM ingestion_generations g
WHERE g.file_id = f.id
  AND g.status = 'active'
  AND f.active_generation_id IS NULL;

UPDATE documents d
SET generation_id = f.active_generation_id
FROM files f
WHERE d.file_id = f.id AND d.generation_id IS NULL;

UPDATE pages p
SET generation_id = f.active_generation_id
FROM files f
WHERE p.file_id = f.id AND p.generation_id IS NULL;

UPDATE chunks c
SET generation_id = f.active_generation_id
FROM files f
WHERE c.file_id = f.id AND c.generation_id IS NULL;

ALTER TABLE documents ALTER COLUMN generation_id SET NOT NULL;
ALTER TABLE pages ALTER COLUMN generation_id SET NOT NULL;
ALTER TABLE chunks ALTER COLUMN generation_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'files_active_generation_fk') THEN
    ALTER TABLE files ADD CONSTRAINT files_active_generation_fk
      FOREIGN KEY (active_generation_id, id)
      REFERENCES ingestion_generations(id, file_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'documents_generation_fk') THEN
    ALTER TABLE documents ADD CONSTRAINT documents_generation_fk
      FOREIGN KEY (generation_id, file_id)
      REFERENCES ingestion_generations(id, file_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pages_generation_fk') THEN
    ALTER TABLE pages ADD CONSTRAINT pages_generation_fk
      FOREIGN KEY (generation_id, file_id)
      REFERENCES ingestion_generations(id, file_id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chunks_generation_fk') THEN
    ALTER TABLE chunks ADD CONSTRAINT chunks_generation_fk
      FOREIGN KEY (generation_id, file_id)
      REFERENCES ingestion_generations(id, file_id) ON DELETE CASCADE;
  END IF;
END $$;

ALTER TABLE pages DROP CONSTRAINT IF EXISTS pages_file_id_page_number_key;
ALTER TABLE chunks DROP CONSTRAINT IF EXISTS chunks_file_id_chunk_index_key;

CREATE UNIQUE INDEX IF NOT EXISTS pages_generation_page_number_idx
  ON pages(generation_id, page_number);
CREATE UNIQUE INDEX IF NOT EXISTS chunks_generation_chunk_index_idx
  ON chunks(generation_id, chunk_index);
CREATE INDEX IF NOT EXISTS documents_generation_idx ON documents(generation_id);
CREATE INDEX IF NOT EXISTS pages_generation_idx ON pages(generation_id);
CREATE INDEX IF NOT EXISTS chunks_generation_idx ON chunks(generation_id);
