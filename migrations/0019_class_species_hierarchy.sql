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
  target_revision_id uuid NOT NULL,
  target_version_id uuid NOT NULL,
  target_entry_id uuid NOT NULL,
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (source_revision_id, target_revision_id),
  FOREIGN KEY (target_revision_id, target_version_id) REFERENCES compendium_revisions(id, version_id),
  FOREIGN KEY (target_version_id, target_entry_id) REFERENCES compendium_versions(id, entry_id)
);
CREATE INDEX IF NOT EXISTS compendium_option_cross_links_target_idx
  ON compendium_option_cross_links(target_entry_id, source_revision_id);

-- Published base classes must have exactly one complete 1-20 table. This is
-- deferred to transaction end so import/editor writes can populate the rows.
CREATE OR REPLACE FUNCTION compendium_revision_is_active(revision uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM compendium_revisions r WHERE r.id = revision AND r.lifecycle = 'published'
  )
$$;

CREATE OR REPLACE FUNCTION compendium_validate_class_progression_revision(revision uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE class_type compendium_class_kind; table_count integer; row_count integer; min_level integer; max_level integer; column_count integer; cell_count integer;
BEGIN
  SELECT class_kind INTO class_type FROM compendium_classes WHERE revision_id = revision;
  IF class_type = 'class' AND compendium_revision_is_active(revision) THEN
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
      RAISE EXCEPTION 'published base class progression must contain exactly one complete levels 1 through 20 table';
    END IF;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION compendium_validate_class_progression() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision uuid;
BEGIN
  IF TG_TABLE_NAME = 'compendium_class_progression_tables' THEN
    revision := coalesce(NEW.class_revision_id, OLD.class_revision_id);
  ELSE
    SELECT class_revision_id INTO revision FROM compendium_class_progression_tables
    WHERE id = coalesce(NEW.table_id, OLD.table_id);
  END IF;
  PERFORM compendium_validate_class_progression_revision(revision);
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

-- Publication transitions validate even when no progression child was ever inserted.
CREATE OR REPLACE FUNCTION compendium_validate_hierarchy_publication() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision uuid; revision_type compendium_entry_type; option_kind text; parent_count integer;
BEGIN
  IF TG_TABLE_NAME = 'compendium_revisions' THEN revision := NEW.id; ELSE revision := NEW.active_revision_id; END IF;
  IF NOT compendium_revision_is_active(revision) THEN RETURN NULL; END IF;
  SELECT entry_type INTO revision_type FROM compendium_revisions WHERE id = revision;
  IF revision_type = 'class' THEN
    PERFORM compendium_validate_class_progression_revision(revision);
    SELECT class_kind::text INTO option_kind FROM compendium_classes WHERE revision_id = revision;
    SELECT count(*) INTO parent_count FROM compendium_class_parent_links WHERE child_revision_id = revision;
    IF (option_kind = 'class' AND parent_count <> 0) OR (option_kind = 'subclass' AND parent_count = 0) THEN
      RAISE EXCEPTION 'published class hierarchy has invalid parent cardinality';
    END IF;
  ELSIF revision_type = 'species' THEN
    SELECT species_kind::text INTO option_kind FROM compendium_species WHERE revision_id = revision;
    SELECT count(*) INTO parent_count FROM compendium_species_parent_links WHERE child_revision_id = revision;
    IF (option_kind = 'species' AND parent_count <> 0) OR (option_kind = 'variant' AND parent_count = 0) THEN
      RAISE EXCEPTION 'published species hierarchy has invalid parent cardinality';
    END IF;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS compendium_revision_hierarchy_publication ON compendium_revisions;
CREATE CONSTRAINT TRIGGER compendium_revision_hierarchy_publication
AFTER INSERT OR UPDATE OF lifecycle ON compendium_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_publication();
DROP TRIGGER IF EXISTS compendium_version_hierarchy_publication ON compendium_versions;
CREATE CONSTRAINT TRIGGER compendium_version_hierarchy_publication
AFTER INSERT OR UPDATE OF lifecycle, active_revision_id ON compendium_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_publication();

CREATE OR REPLACE FUNCTION compendium_guard_hierarchy_child_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE revision uuid;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'compendium_class_parent_links' THEN revision := OLD.child_revision_id;
    WHEN 'compendium_species_parent_links' THEN revision := OLD.child_revision_id;
    WHEN 'compendium_class_progression_tables' THEN revision := OLD.class_revision_id;
    WHEN 'compendium_class_progression_columns' THEN SELECT class_revision_id INTO revision FROM compendium_class_progression_tables WHERE id = OLD.table_id;
    WHEN 'compendium_class_progression_rows' THEN SELECT class_revision_id INTO revision FROM compendium_class_progression_tables WHERE id = OLD.table_id;
    WHEN 'compendium_class_progression_cells' THEN SELECT class_revision_id INTO revision FROM compendium_class_progression_tables WHERE id = OLD.table_id;
    WHEN 'compendium_class_feature_links' THEN revision := OLD.class_revision_id;
    WHEN 'compendium_species_traits' THEN revision := OLD.species_revision_id;
    WHEN 'compendium_option_cross_links' THEN revision := OLD.source_revision_id;
  END CASE;
  IF compendium_revision_is_active(revision) THEN RAISE EXCEPTION 'active hierarchy revision children are immutable'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'compendium_class_parent_links','compendium_species_parent_links','compendium_class_progression_tables',
    'compendium_class_progression_columns','compendium_class_progression_rows','compendium_class_progression_cells',
    'compendium_class_feature_links','compendium_species_traits','compendium_option_cross_links'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', table_name || '_active_immutable', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION compendium_guard_hierarchy_child_immutability()', table_name || '_active_immutable', table_name);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION compendium_validate_hierarchy_graph() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE walk(child_revision_id, parent_revision_id, path, cycle) AS (
      SELECT child_revision_id, parent_revision_id, ARRAY[child_revision_id, parent_revision_id], child_revision_id = parent_revision_id FROM compendium_class_parent_links
      UNION ALL SELECT walk.child_revision_id, link.parent_revision_id, walk.path || link.parent_revision_id, link.parent_revision_id = ANY(walk.path)
      FROM walk JOIN compendium_class_parent_links link ON link.child_revision_id = walk.parent_revision_id WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle
  ) OR EXISTS (
    WITH RECURSIVE walk(child_revision_id, parent_revision_id, path, cycle) AS (
      SELECT child_revision_id, parent_revision_id, ARRAY[child_revision_id, parent_revision_id], child_revision_id = parent_revision_id FROM compendium_species_parent_links
      UNION ALL SELECT walk.child_revision_id, link.parent_revision_id, walk.path || link.parent_revision_id, link.parent_revision_id = ANY(walk.path)
      FROM walk JOIN compendium_species_parent_links link ON link.child_revision_id = walk.parent_revision_id WHERE NOT walk.cycle
    ) SELECT 1 FROM walk WHERE cycle
  ) THEN RAISE EXCEPTION 'hierarchy graph cannot contain cycles'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_class_parent_links link
    JOIN compendium_classes child ON child.revision_id = link.child_revision_id
    JOIN compendium_classes parent ON parent.revision_id = link.parent_revision_id
    JOIN compendium_revisions cr ON cr.id = child.revision_id JOIN compendium_versions cv ON cv.id = cr.version_id
    JOIN compendium_revisions pr ON pr.id = parent.revision_id JOIN compendium_versions pv ON pv.id = pr.version_id
    WHERE child.class_kind <> 'subclass' OR pr.lifecycle <> 'published' OR pv.lifecycle <> 'published' OR pv.active_revision_id <> pr.id
      OR cv.source_id <> pv.source_id OR cv.edition <> pv.edition OR cv.language <> pv.language
  ) THEN RAISE EXCEPTION 'class parent must be an active exact-corpus class hierarchy version'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_species_parent_links link
    JOIN compendium_species child ON child.revision_id = link.child_revision_id
    JOIN compendium_species parent ON parent.revision_id = link.parent_revision_id
    JOIN compendium_revisions cr ON cr.id = child.revision_id JOIN compendium_versions cv ON cv.id = cr.version_id
    JOIN compendium_revisions pr ON pr.id = parent.revision_id JOIN compendium_versions pv ON pv.id = pr.version_id
    WHERE child.species_kind <> 'variant' OR pr.lifecycle <> 'published' OR pv.lifecycle <> 'published' OR pv.active_revision_id <> pr.id
      OR cv.source_id <> pv.source_id OR cv.edition <> pv.edition OR cv.language <> pv.language
  ) THEN RAISE EXCEPTION 'species parent must be an active exact-corpus species hierarchy version'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_class_parent_links direct JOIN compendium_classes parent ON parent.revision_id = direct.parent_revision_id
    WHERE parent.class_kind = 'subclass' AND NOT EXISTS (
      WITH RECURSIVE ancestors(revision_id) AS (
        SELECT direct.parent_revision_id
        UNION SELECT link.parent_revision_id FROM ancestors JOIN compendium_class_parent_links link ON link.child_revision_id = ancestors.revision_id
      ) SELECT 1 FROM ancestors JOIN compendium_classes base ON base.revision_id = ancestors.revision_id WHERE base.class_kind = 'class'
    )
  ) THEN RAISE EXCEPTION 'subclass parent chains must explicitly terminate at a base class'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_species_parent_links direct JOIN compendium_species parent ON parent.revision_id = direct.parent_revision_id
    WHERE parent.species_kind = 'variant' AND NOT EXISTS (
      WITH RECURSIVE ancestors(revision_id) AS (
        SELECT direct.parent_revision_id
        UNION SELECT link.parent_revision_id FROM ancestors JOIN compendium_species_parent_links link ON link.child_revision_id = ancestors.revision_id
      ) SELECT 1 FROM ancestors JOIN compendium_species base ON base.revision_id = ancestors.revision_id WHERE base.species_kind = 'species'
    )
  ) THEN RAISE EXCEPTION 'variant parent chains must explicitly terminate at a base species'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_class_feature_links link
    JOIN compendium_revisions cr ON cr.id = link.class_revision_id JOIN compendium_versions cv ON cv.id = cr.version_id
    JOIN compendium_revisions fr ON fr.id = link.feature_revision_id JOIN compendium_versions fv ON fv.id = fr.version_id
    WHERE fr.lifecycle <> 'published' OR fv.lifecycle <> 'published' OR fv.active_revision_id <> fr.id
      OR cv.source_id <> fv.source_id OR cv.edition <> fv.edition OR cv.language <> fv.language
  ) THEN RAISE EXCEPTION 'class feature must target an active exact-corpus feature version'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_option_cross_links link
    JOIN compendium_revisions sr ON sr.id = link.source_revision_id JOIN compendium_versions sv ON sv.id = sr.version_id
    JOIN compendium_revisions tr ON tr.id = link.target_revision_id JOIN compendium_versions tv ON tv.id = tr.version_id
    WHERE tr.lifecycle <> 'published' OR tv.lifecycle <> 'published' OR tv.active_revision_id <> tr.id
      OR sv.source_id <> tv.source_id OR sv.edition <> tv.edition OR sv.language <> tv.language
  ) THEN RAISE EXCEPTION 'cross-link must target an active exact-corpus revision'; END IF;

  IF EXISTS (
    SELECT 1 FROM compendium_species_traits trait JOIN compendium_species species ON species.revision_id = trait.species_revision_id
    WHERE trait.overrides_trait_key IS NOT NULL AND (
      species.species_kind <> 'variant' OR NOT EXISTS (
        WITH RECURSIVE ancestors(revision_id) AS (
          SELECT parent_revision_id FROM compendium_species_parent_links WHERE child_revision_id = trait.species_revision_id
          UNION SELECT link.parent_revision_id FROM ancestors JOIN compendium_species_parent_links link ON link.child_revision_id = ancestors.revision_id
        ) SELECT 1 FROM ancestors JOIN compendium_species_traits inherited ON inherited.species_revision_id = ancestors.revision_id
        WHERE inherited.trait_key = trait.overrides_trait_key
      )
    )
  ) THEN RAISE EXCEPTION 'trait override must resolve an inherited parent trait'; END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS compendium_class_graph_valid ON compendium_class_parent_links;
CREATE CONSTRAINT TRIGGER compendium_class_graph_valid AFTER INSERT OR UPDATE OR DELETE ON compendium_class_parent_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_species_graph_valid ON compendium_species_parent_links;
CREATE CONSTRAINT TRIGGER compendium_species_graph_valid AFTER INSERT OR UPDATE OR DELETE ON compendium_species_parent_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_feature_graph_valid ON compendium_class_feature_links;
CREATE CONSTRAINT TRIGGER compendium_feature_graph_valid AFTER INSERT OR UPDATE OR DELETE ON compendium_class_feature_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_trait_graph_valid ON compendium_species_traits;
CREATE CONSTRAINT TRIGGER compendium_trait_graph_valid AFTER INSERT OR UPDATE OR DELETE ON compendium_species_traits
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_cross_link_graph_valid ON compendium_option_cross_links;
CREATE CONSTRAINT TRIGGER compendium_cross_link_graph_valid AFTER INSERT OR UPDATE OR DELETE ON compendium_option_cross_links
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_revision_graph_valid ON compendium_revisions;
CREATE CONSTRAINT TRIGGER compendium_revision_graph_valid AFTER UPDATE OF lifecycle ON compendium_revisions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();
DROP TRIGGER IF EXISTS compendium_version_graph_valid ON compendium_versions;
CREATE CONSTRAINT TRIGGER compendium_version_graph_valid AFTER UPDATE OF lifecycle, active_revision_id ON compendium_versions
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION compendium_validate_hierarchy_graph();

ALTER TABLE compendium_class_feature_links DROP CONSTRAINT IF EXISTS compendium_class_feature_anchor_not_reserved;
ALTER TABLE compendium_class_feature_links ADD CONSTRAINT compendium_class_feature_anchor_not_reserved CHECK (
  anchor <> 'progression' AND anchor !~ '^level-([1-9]|1[0-9]|20)$' AND anchor !~ '^section(?:-|$)'
);
ALTER TABLE compendium_species_traits DROP CONSTRAINT IF EXISTS compendium_species_trait_anchor_not_reserved;
ALTER TABLE compendium_species_traits ADD CONSTRAINT compendium_species_trait_anchor_not_reserved CHECK (
  anchor <> 'progression' AND anchor !~ '^level-([1-9]|1[0-9]|20)$' AND anchor !~ '^section(?:-|$)'
);

CREATE TABLE IF NOT EXISTS nfs_index_option_relations (
  repository_id text NOT NULL,
  source_entry_id text NOT NULL,
  source_revision_id text NOT NULL,
  source_id uuid NOT NULL,
  target_entry_id text NOT NULL,
  target_revision_id text NOT NULL,
  target_source_id uuid NOT NULL,
  edition source_edition NOT NULL,
  language source_language NOT NULL,
  relation_kind text NOT NULL CHECK (relation_kind IN ('parent','feature','cross_link')),
  target_kind text NOT NULL CHECK (target_kind IN ('class','subclass','species','variant','feature','other')),
  target_lifecycle nfs_index_entry_lifecycle NOT NULL CHECK (target_lifecycle = 'active'),
  anchor text,
  position smallint NOT NULL DEFAULT 0 CHECK (position >= 0),
  PRIMARY KEY (repository_id, source_entry_id, source_revision_id, target_entry_id, target_revision_id, relation_kind),
  CHECK (source_id = target_source_id),
  CHECK (anchor IS NULL OR anchor ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$')
);
CREATE INDEX IF NOT EXISTS nfs_index_option_relations_target_idx ON nfs_index_option_relations
  (repository_id, target_entry_id, target_revision_id, target_source_id);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfs_index_entries_exact_version_unique') THEN
    ALTER TABLE nfs_index_entries ADD CONSTRAINT nfs_index_entries_exact_version_unique
      UNIQUE (repository_id, entry_id, revision_id, source_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfs_option_relations_source_fk') THEN
    ALTER TABLE nfs_index_option_relations ADD CONSTRAINT nfs_option_relations_source_fk
      FOREIGN KEY (repository_id, source_entry_id, source_revision_id, source_id)
      REFERENCES nfs_index_entries(repository_id, entry_id, revision_id, source_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfs_option_relations_target_fk') THEN
    ALTER TABLE nfs_index_option_relations ADD CONSTRAINT nfs_option_relations_target_fk
      FOREIGN KEY (repository_id, target_entry_id, target_revision_id, target_source_id)
      REFERENCES nfs_index_entries(repository_id, entry_id, revision_id, source_id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION nfs_index_validate_option_relation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actual_kind text;
BEGIN
  SELECT CASE
    WHEN target.entry_id LIKE 'class-%' THEN coalesce(fields.values->>'kind','class')
    WHEN target.entry_id LIKE 'species-%' THEN coalesce(fields.values->>'kind','species')
    WHEN target.entry_id LIKE 'feature-%' THEN 'feature'
    ELSE 'other' END INTO actual_kind
  FROM nfs_index_entries source
  JOIN sources source_meta ON source_meta.id = source.source_id
  JOIN nfs_index_entries target ON target.repository_id = NEW.repository_id
    AND target.entry_id = NEW.target_entry_id AND target.revision_id = NEW.target_revision_id
    AND target.source_id = NEW.target_source_id
  JOIN sources target_meta ON target_meta.id = target.source_id
  CROSS JOIN LATERAL (SELECT coalesce(jsonb_object_agg(field->>'key',field->'value'),'{}') AS values
    FROM jsonb_array_elements(target.typed_fields) field) fields
  WHERE source.repository_id = NEW.repository_id AND source.entry_id = NEW.source_entry_id
    AND source.revision_id = NEW.source_revision_id AND source.source_id = NEW.source_id
    AND source.lifecycle = 'active' AND target.lifecycle = 'active'
    AND source.source_id = target.source_id AND source_meta.edition = target_meta.edition
    AND source_meta.language = target_meta.language AND source_meta.edition = NEW.edition
    AND source_meta.language = NEW.language;
  IF actual_kind IS NULL OR actual_kind <> NEW.target_kind THEN
    RAISE EXCEPTION 'NFS option relation target must be an exact active same-corpus version with matching kind';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS nfs_index_option_relation_valid ON nfs_index_option_relations;
CREATE CONSTRAINT TRIGGER nfs_index_option_relation_valid AFTER INSERT OR UPDATE ON nfs_index_option_relations
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION nfs_index_validate_option_relation();

CREATE OR REPLACE FUNCTION nfs_index_validate_entry_relations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM nfs_index_option_relations relation
    JOIN nfs_index_entries source ON source.repository_id = relation.repository_id
      AND source.entry_id = relation.source_entry_id AND source.revision_id = relation.source_revision_id AND source.source_id = relation.source_id
    JOIN nfs_index_entries target ON target.repository_id = relation.repository_id
      AND target.entry_id = relation.target_entry_id AND target.revision_id = relation.target_revision_id AND target.source_id = relation.target_source_id
    WHERE source.lifecycle <> 'active' OR target.lifecycle <> 'active'
  ) THEN RAISE EXCEPTION 'NFS option relations cannot reference retired or stale entry versions'; END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS nfs_index_entry_relations_valid ON nfs_index_entries;
CREATE CONSTRAINT TRIGGER nfs_index_entry_relations_valid
AFTER UPDATE OF revision_id, source_id, lifecycle ON nfs_index_entries DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION nfs_index_validate_entry_relations();
