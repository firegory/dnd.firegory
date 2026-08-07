-- Complete the typed projections for flat compendium entries. Existing tables
-- are retained; this migration only tightens their browse and publication path.
ALTER TYPE compendium_entry_type ADD VALUE IF NOT EXISTS 'glossary';

ALTER TABLE nfs_index_entries
  ADD COLUMN IF NOT EXISTS edition source_edition,
  ADD COLUMN IF NOT EXISTS language source_language;
UPDATE nfs_index_entries entry SET edition = source.edition, language = source.language
FROM sources source WHERE source.id = entry.source_id AND (entry.edition IS NULL OR entry.language IS NULL);
ALTER TABLE nfs_index_entries ALTER COLUMN edition SET NOT NULL;
ALTER TABLE nfs_index_entries ALTER COLUMN language SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'nfs_index_entries_source_corpus_fk') THEN
    ALTER TABLE nfs_index_entries ADD CONSTRAINT nfs_index_entries_source_corpus_fk
      FOREIGN KEY (source_id, edition, language) REFERENCES sources(id, edition, language);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compendium_glossary (
  revision_id uuid PRIMARY KEY,
  entry_type text GENERATED ALWAYS AS ('glossary') STORED,
  category text NOT NULL,
  related_terms text[] NOT NULL DEFAULT ARRAY[]::text[],
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id) REFERENCES compendium_revisions(id) ON DELETE CASCADE,
  CONSTRAINT compendium_glossary_category_valid CHECK (btrim(category) <> ''),
  CONSTRAINT compendium_glossary_related_terms_valid CHECK (
    array_position(related_terms, NULL) IS NULL AND array_position(related_terms, '') IS NULL
  ),
  CONSTRAINT compendium_glossary_extension_object CHECK (jsonb_typeof(extension_data) = 'object')
);

CREATE INDEX IF NOT EXISTS compendium_backgrounds_filters_idx
  ON compendium_backgrounds (ability_scores, skill_proficiencies, revision_id);
CREATE INDEX IF NOT EXISTS compendium_feats_filters_idx
  ON compendium_feats (category, prerequisite_level, repeatable, revision_id);
CREATE INDEX IF NOT EXISTS compendium_items_filters_idx
  ON compendium_items (category, rarity, requires_attunement, revision_id);
CREATE INDEX IF NOT EXISTS compendium_equipment_filters_idx
  ON compendium_equipment (category, cost_cp, weight_lb, revision_id);
CREATE INDEX IF NOT EXISTS compendium_glossary_filters_idx
  ON compendium_glossary (category, revision_id);
CREATE INDEX IF NOT EXISTS compendium_glossary_related_terms_idx
  ON compendium_glossary USING gin (related_terms);

CREATE OR REPLACE FUNCTION nfs_index_typed_number(fields jsonb, field_key text) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT CASE WHEN jsonb_typeof(field->'value') = 'number' THEN (field->>'value')::numeric END
  FROM jsonb_array_elements(fields) field WHERE field->>'key' = field_key LIMIT 1
$$;
CREATE INDEX IF NOT EXISTS nfs_index_entries_flat_browse_idx
  ON nfs_index_entries (entry_type, edition, language, lower(name) COLLATE "C", entry_id)
  WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS nfs_index_entries_typed_fields_idx
  ON nfs_index_entries USING gin (typed_fields jsonb_path_ops) WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS nfs_index_entries_feat_level_idx
  ON nfs_index_entries (nfs_index_typed_number(typed_fields, 'prerequisite-level'))
  WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS nfs_index_entries_equipment_cost_idx
  ON nfs_index_entries (nfs_index_typed_number(typed_fields, 'cost-cp'))
  WHERE lifecycle = 'active';
CREATE INDEX IF NOT EXISTS nfs_index_entries_equipment_weight_idx
  ON nfs_index_entries (nfs_index_typed_number(typed_fields, 'weight-lb'))
  WHERE lifecycle = 'active';

CREATE OR REPLACE FUNCTION compendium_validate_glossary_revision_type() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM compendium_revisions WHERE id = NEW.revision_id AND entry_type::text = 'glossary') THEN
    RAISE EXCEPTION 'glossary projection requires a glossary revision';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_glossary_revision_type ON compendium_glossary;
CREATE TRIGGER compendium_glossary_revision_type BEFORE INSERT ON compendium_glossary
FOR EACH ROW EXECUTE FUNCTION compendium_validate_glossary_revision_type();

CREATE OR REPLACE FUNCTION compendium_revision_has_projection(revision uuid, revision_type compendium_entry_type)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
  SELECT CASE revision_type::text
    WHEN 'spell' THEN EXISTS (SELECT 1 FROM compendium_spells WHERE revision_id = revision)
    WHEN 'creature' THEN EXISTS (SELECT 1 FROM compendium_creatures WHERE revision_id = revision)
    WHEN 'item' THEN EXISTS (SELECT 1 FROM compendium_items WHERE revision_id = revision)
    WHEN 'class' THEN EXISTS (SELECT 1 FROM compendium_classes WHERE revision_id = revision)
    WHEN 'feature' THEN EXISTS (SELECT 1 FROM compendium_features WHERE revision_id = revision)
    WHEN 'species' THEN EXISTS (SELECT 1 FROM compendium_species WHERE revision_id = revision)
    WHEN 'background' THEN EXISTS (SELECT 1 FROM compendium_backgrounds WHERE revision_id = revision)
    WHEN 'feat' THEN EXISTS (SELECT 1 FROM compendium_feats WHERE revision_id = revision)
    WHEN 'equipment' THEN EXISTS (SELECT 1 FROM compendium_equipment WHERE revision_id = revision)
    WHEN 'glossary' THEN EXISTS (SELECT 1 FROM compendium_glossary WHERE revision_id = revision)
    ELSE false
  END
$$;

DROP TRIGGER IF EXISTS compendium_revision_child_immutable ON compendium_glossary;
CREATE TRIGGER compendium_revision_child_immutable
BEFORE INSERT OR UPDATE OR DELETE ON compendium_glossary
FOR EACH ROW EXECUTE FUNCTION compendium_guard_revision_children_immutability();
