ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'class';

ALTER TABLE entities ADD COLUMN IF NOT EXISTS parent_entity_id uuid REFERENCES entities(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS entities_parent_entity_id_idx ON entities(parent_entity_id) WHERE parent_entity_id IS NOT NULL;
