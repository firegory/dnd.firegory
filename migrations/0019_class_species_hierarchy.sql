-- Version-owned class/subclass and species/variant hierarchy. Parent and
-- feature membership are junctions because an option can be reprinted into,
-- or inherited from, more than one source-version-specific option.

DO $$ BEGIN CREATE TYPE compendium_class_kind AS ENUM ('class', 'subclass');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_species_kind AS ENUM ('species', 'variant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE compendium_classes
  ADD COLUMN IF NOT EXISTS class_kind compendium_class_kind NOT NULL DEFAULT 'class';
ALTER TABLE compendium_species
  ADD COLUMN IF NOT EXISTS species_kind compendium_species_kind NOT NULL DEFAULT 'species';

CREATE TABLE IF NOT EXISTS compendium_class_parent_links (
  child_revision_id uuid NOT NULL REFERENCES compendium_classes(revision_id) ON DELETE CASCADE,
  parent_revision_id uuid NOT NULL REFERENCES compendium_classes(revision_id),
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (child_revision_id, parent_revision_id),
  CHECK (child_revision_id <> parent_revision_id)
);
CREATE INDEX IF NOT EXISTS compendium_class_parent_links_parent_idx
  ON compendium_class_parent_links(parent_revision_id, child_revision_id);

CREATE TABLE IF NOT EXISTS compendium_species_parent_links (
  child_revision_id uuid NOT NULL REFERENCES compendium_species(revision_id) ON DELETE CASCADE,
  parent_revision_id uuid NOT NULL REFERENCES compendium_species(revision_id),
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (child_revision_id, parent_revision_id),
  CHECK (child_revision_id <> parent_revision_id)
);
CREATE INDEX IF NOT EXISTS compendium_species_parent_links_parent_idx
  ON compendium_species_parent_links(parent_revision_id, child_revision_id);

CREATE TABLE IF NOT EXISTS compendium_class_progression_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_revision_id uuid NOT NULL REFERENCES compendium_classes(revision_id) ON DELETE CASCADE,
  table_key text NOT NULL,
  title text NOT NULL,
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  UNIQUE (class_revision_id, table_key),
  UNIQUE (id, class_revision_id),
  CHECK (table_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$' AND btrim(title) <> '')
);

CREATE TABLE IF NOT EXISTS compendium_class_progression_columns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES compendium_class_progression_tables(id) ON DELETE CASCADE,
  column_key text NOT NULL,
  heading text NOT NULL,
  position smallint NOT NULL CHECK (position >= 0),
  UNIQUE (table_id, column_key),
  UNIQUE (table_id, position),
  UNIQUE (id, table_id),
  CHECK (column_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$' AND btrim(heading) <> '')
);

CREATE TABLE IF NOT EXISTS compendium_class_progression_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id uuid NOT NULL REFERENCES compendium_class_progression_tables(id) ON DELETE CASCADE,
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 20),
  UNIQUE (table_id, level),
  UNIQUE (id, table_id)
);

CREATE TABLE IF NOT EXISTS compendium_class_progression_cells (
  row_id uuid NOT NULL,
  table_id uuid NOT NULL,
  column_id uuid NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (row_id, column_id),
  FOREIGN KEY (row_id, table_id) REFERENCES compendium_class_progression_rows(id, table_id) ON DELETE CASCADE,
  FOREIGN KEY (column_id, table_id) REFERENCES compendium_class_progression_columns(id, table_id) ON DELETE CASCADE,
  CHECK (btrim(value) <> '')
);

CREATE TABLE IF NOT EXISTS compendium_class_feature_links (
  class_revision_id uuid NOT NULL REFERENCES compendium_classes(revision_id) ON DELETE CASCADE,
  feature_revision_id uuid NOT NULL REFERENCES compendium_features(revision_id),
  level smallint NOT NULL CHECK (level BETWEEN 1 AND 20),
  anchor text NOT NULL,
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (class_revision_id, feature_revision_id),
  UNIQUE (class_revision_id, anchor),
  CHECK (anchor ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$')
);
CREATE INDEX IF NOT EXISTS compendium_class_feature_links_feature_idx
  ON compendium_class_feature_links(feature_revision_id, class_revision_id);

CREATE TABLE IF NOT EXISTS compendium_species_traits (
  species_revision_id uuid NOT NULL REFERENCES compendium_species(revision_id) ON DELETE CASCADE,
  trait_key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  anchor text NOT NULL,
  overrides_trait_key text,
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (species_revision_id, trait_key),
  UNIQUE (species_revision_id, anchor),
  CHECK (trait_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'),
  CHECK (anchor ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'),
  CHECK (overrides_trait_key IS NULL OR overrides_trait_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'),
  CHECK (btrim(title) <> '' AND btrim(body) <> '')
);

CREATE TABLE IF NOT EXISTS compendium_option_cross_links (
  source_revision_id uuid NOT NULL REFERENCES compendium_revisions(id) ON DELETE CASCADE,
  target_entry_id uuid NOT NULL REFERENCES compendium_entries(id),
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (source_revision_id, target_entry_id)
);
CREATE INDEX IF NOT EXISTS compendium_option_cross_links_target_idx
  ON compendium_option_cross_links(target_entry_id, source_revision_id);

-- Published base classes must have exactly one complete 1-20 table. This is
-- deferred to transaction end so import/editor writes can populate the rows.
CREATE OR REPLACE FUNCTION compendium_validate_class_progression() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision uuid; class_type compendium_class_kind; table_count integer; row_count integer; min_level integer; max_level integer; column_count integer; cell_count integer;
BEGIN
  IF TG_TABLE_NAME = 'compendium_class_progression_tables' THEN
    revision := coalesce(NEW.class_revision_id, OLD.class_revision_id);
  ELSE
    SELECT class_revision_id INTO revision FROM compendium_class_progression_tables
    WHERE id = coalesce(NEW.table_id, OLD.table_id);
  END IF;
  SELECT class_kind INTO class_type FROM compendium_classes WHERE revision_id = revision;
  IF class_type = 'class' THEN
    SELECT count(*) INTO table_count FROM compendium_class_progression_tables WHERE class_revision_id = revision;
    SELECT count(*), min(r.level), max(r.level) INTO row_count, min_level, max_level
    FROM compendium_class_progression_tables t JOIN compendium_class_progression_rows r ON r.table_id = t.id
    WHERE t.class_revision_id = revision;
    SELECT count(*) INTO column_count FROM compendium_class_progression_columns c
    JOIN compendium_class_progression_tables t ON t.id = c.table_id WHERE t.class_revision_id = revision;
    SELECT count(*) INTO cell_count FROM compendium_class_progression_cells c
    JOIN compendium_class_progression_tables t ON t.id = c.table_id WHERE t.class_revision_id = revision;
    IF table_count <> 1 OR row_count <> 20 OR min_level <> 1 OR max_level <> 20
       OR column_count < 1 OR cell_count <> row_count * column_count THEN
      RAISE EXCEPTION 'base class progression must contain each level 1 through 20 exactly once';
    END IF;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS compendium_class_progression_complete ON compendium_class_progression_tables;
CREATE CONSTRAINT TRIGGER compendium_class_progression_complete
AFTER INSERT OR UPDATE OR DELETE ON compendium_class_progression_tables
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_class_progression();
DROP TRIGGER IF EXISTS compendium_class_progression_rows_complete ON compendium_class_progression_rows;
CREATE CONSTRAINT TRIGGER compendium_class_progression_rows_complete
AFTER INSERT OR UPDATE OR DELETE ON compendium_class_progression_rows
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_class_progression();
DROP TRIGGER IF EXISTS compendium_class_progression_columns_complete ON compendium_class_progression_columns;
CREATE CONSTRAINT TRIGGER compendium_class_progression_columns_complete
AFTER INSERT OR UPDATE OR DELETE ON compendium_class_progression_columns
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_class_progression();
DROP TRIGGER IF EXISTS compendium_class_progression_cells_complete ON compendium_class_progression_cells;
CREATE CONSTRAINT TRIGGER compendium_class_progression_cells_complete
AFTER INSERT OR UPDATE OR DELETE ON compendium_class_progression_cells
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_class_progression();
