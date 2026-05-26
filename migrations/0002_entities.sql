CREATE TYPE entity_type AS ENUM (
  'spell', 'feat', 'class_feature', 'monster', 'magic_item',
  'species', 'subclass', 'background', 'other'
);

CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  entity_type entity_type NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  page_numbers integer[] NOT NULL DEFAULT ARRAY[]::integer[],
  chunk_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT entities_name_not_blank CHECK (btrim(name) <> '')
);

CREATE INDEX entities_entity_type_idx ON entities(entity_type);
CREATE INDEX entities_source_id_idx ON entities(source_id);
CREATE INDEX entities_file_id_idx ON entities(file_id);
CREATE INDEX entities_attributes_gin_idx ON entities USING gin (attributes);

ALTER TABLE ingestion_jobs
  ADD COLUMN IF NOT EXISTS entity_count integer;
