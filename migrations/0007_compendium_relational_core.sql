-- Normalized, source-bound compendium core. This migration is additive: it
-- does not project, rewrite, or delete existing ingestion data.

DO $$ BEGIN CREATE TYPE compendium_entry_type AS ENUM (
  'spell', 'creature', 'item', 'class', 'feature', 'species', 'background', 'feat', 'equipment'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_version_lifecycle AS ENUM ('draft', 'published', 'retired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_revision_lifecycle AS ENUM ('draft', 'published');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_name_kind AS ENUM ('slug', 'alias');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_relation_type AS ENUM (
  'related', 'requires', 'grants', 'replaces', 'member_of', 'prerequisite'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_citation_kind AS ENUM ('field', 'block');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE compendium_import_status AS ENUM ('pending', 'running', 'succeeded', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE spell_school AS ENUM (
  'abjuration', 'conjuration', 'divination', 'enchantment', 'evocation',
  'illusion', 'necromancy', 'transmutation'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE creature_size AS ENUM ('tiny', 'small', 'medium', 'large', 'huge', 'gargantuan');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE item_rarity AS ENUM ('common', 'uncommon', 'rare', 'very_rare', 'legendary', 'artifact', 'varies');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE item_category AS ENUM (
  'armor', 'potion', 'ring', 'rod', 'scroll', 'staff', 'wand', 'weapon', 'wondrous', 'other'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE feat_category AS ENUM ('origin', 'general', 'fighting_style', 'epic_boon');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE equipment_category AS ENUM (
  'adventuring_gear', 'ammunition', 'armor', 'focus', 'mount', 'tool', 'vehicle', 'weapon', 'other'
); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  IF current_setting('server_encoding') <> 'UTF8' THEN
    RAISE EXCEPTION 'compendium name normalization requires UTF8 server_encoding';
  END IF;
END $$;

-- Composite candidate keys let every downstream FK prove corpus ownership.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sources_id_edition_language_unique') THEN
    ALTER TABLE sources ADD CONSTRAINT sources_id_edition_language_unique UNIQUE (id, edition, language);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chunks_compendium_owner_unique') THEN
    ALTER TABLE chunks ADD CONSTRAINT chunks_compendium_owner_unique
      UNIQUE (id, generation_id, file_id, source_id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS compendium_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  canonical_key text NOT NULL,
  entry_type compendium_entry_type NOT NULL,
  edition source_edition NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_entries_canonical_key_format CHECK (
    canonical_key ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$'
  ),
  CONSTRAINT compendium_entries_identity_unique UNIQUE (entry_type, edition, canonical_key),
  CONSTRAINT compendium_entries_id_edition_unique UNIQUE (id, edition),
  CONSTRAINT compendium_entries_id_edition_type_unique UNIQUE (id, edition, entry_type)
);

CREATE TABLE IF NOT EXISTS compendium_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id uuid NOT NULL,
  entry_type compendium_entry_type NOT NULL,
  edition source_edition NOT NULL,
  language source_language NOT NULL,
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  lifecycle compendium_version_lifecycle NOT NULL DEFAULT 'draft',
  active_revision_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  retired_at timestamptz,
  CONSTRAINT compendium_versions_entry_fk FOREIGN KEY (entry_id, edition, entry_type)
    REFERENCES compendium_entries(id, edition, entry_type),
  CONSTRAINT compendium_versions_source_corpus_fk FOREIGN KEY (source_id, edition, language)
    REFERENCES sources(id, edition, language),
  CONSTRAINT compendium_versions_file_source_fk FOREIGN KEY (file_id, source_id)
    REFERENCES files(id, source_id),
  CONSTRAINT compendium_versions_active_policy CHECK (
    (lifecycle = 'draft' AND published_at IS NULL AND retired_at IS NULL)
    OR (lifecycle = 'published' AND active_revision_id IS NOT NULL AND published_at IS NOT NULL AND retired_at IS NULL)
    OR (lifecycle = 'retired' AND active_revision_id IS NOT NULL AND published_at IS NOT NULL AND retired_at IS NOT NULL)
  ),
  CONSTRAINT compendium_versions_source_identity_unique UNIQUE (entry_id, source_id, file_id, language),
  CONSTRAINT compendium_versions_id_entry_type_unique UNIQUE (id, entry_type),
  CONSTRAINT compendium_versions_id_entry_unique UNIQUE (id, entry_id),
  CONSTRAINT compendium_versions_id_source_file_unique UNIQUE (id, source_id, file_id),
  CONSTRAINT compendium_versions_import_owner_unique UNIQUE (id, entry_id, source_id, file_id),
  CONSTRAINT compendium_versions_name_owner_unique UNIQUE (id, entry_id, entry_type, edition, language)
);

CREATE TABLE IF NOT EXISTS compendium_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  entry_type compendium_entry_type NOT NULL,
  revision_number integer NOT NULL,
  lifecycle compendium_revision_lifecycle NOT NULL DEFAULT 'draft',
  title text NOT NULL,
  summary text,
  body text NOT NULL,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  CONSTRAINT compendium_revisions_version_type_fk FOREIGN KEY (version_id, entry_type)
    REFERENCES compendium_versions(id, entry_type) DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT compendium_revisions_number_positive CHECK (revision_number > 0),
  CONSTRAINT compendium_revisions_text_not_blank CHECK (btrim(title) <> '' AND btrim(body) <> ''),
  CONSTRAINT compendium_revisions_extension_object CHECK (jsonb_typeof(extension_data) = 'object'),
  CONSTRAINT compendium_revisions_lifecycle_timestamps CHECK (
    (lifecycle = 'draft' AND published_at IS NULL)
    OR (lifecycle = 'published' AND published_at IS NOT NULL)
  ),
  CONSTRAINT compendium_revisions_version_number_unique UNIQUE (version_id, revision_number),
  CONSTRAINT compendium_revisions_id_version_unique UNIQUE (id, version_id),
  CONSTRAINT compendium_revisions_id_version_type_unique UNIQUE (id, version_id, entry_type),
  CONSTRAINT compendium_revisions_id_type_unique UNIQUE (id, entry_type)
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_versions_active_revision_fk') THEN
    ALTER TABLE compendium_versions ADD CONSTRAINT compendium_versions_active_revision_fk
      FOREIGN KEY (active_revision_id, id)
      REFERENCES compendium_revisions(id, version_id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION compendium_normalize_name(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT trim(BOTH '-' FROM regexp_replace(lower(btrim(normalize(value, NFC))), '[-_[:space:].,/:;!?()]+', '-', 'g'))
$$;

-- Slugs and aliases intentionally share one registry and one conflict scope:
-- (entry type, edition, language, normalized name). This means an alias can
-- never shadow a browsable slug, including under concurrent writes.
CREATE TABLE IF NOT EXISTS compendium_names (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id uuid NOT NULL,
  entry_id uuid NOT NULL,
  entry_type compendium_entry_type NOT NULL,
  edition source_edition NOT NULL,
  language source_language NOT NULL,
  kind compendium_name_kind NOT NULL,
  name text NOT NULL,
  normalized_name text GENERATED ALWAYS AS (compendium_normalize_name(name)) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_names_version_scope_fk
    FOREIGN KEY (version_id, entry_id, entry_type, edition, language)
    REFERENCES compendium_versions(id, entry_id, entry_type, edition, language) ON DELETE CASCADE,
  CONSTRAINT compendium_names_not_blank CHECK (btrim(name) <> '' AND compendium_normalize_name(name) <> ''),
  CONSTRAINT compendium_names_slug_format CHECK (
    kind <> 'slug' OR (name = normalized_name AND name ~ '^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$')
  ),
  CONSTRAINT compendium_names_scope_unique UNIQUE (entry_type, edition, language, normalized_name)
);
CREATE UNIQUE INDEX IF NOT EXISTS compendium_names_one_slug_per_version_idx
  ON compendium_names(version_id) WHERE kind = 'slug';
CREATE INDEX IF NOT EXISTS compendium_names_lookup_idx
  ON compendium_names(entry_type, edition, language, normalized_name) INCLUDE (version_id, kind);

CREATE TABLE IF NOT EXISTS compendium_entry_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entry_id uuid NOT NULL,
  target_entry_id uuid NOT NULL,
  edition source_edition NOT NULL,
  relation_type compendium_relation_type NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_relations_source_edition_fk FOREIGN KEY (source_entry_id, edition)
    REFERENCES compendium_entries(id, edition) ON DELETE CASCADE,
  CONSTRAINT compendium_relations_target_edition_fk FOREIGN KEY (target_entry_id, edition)
    REFERENCES compendium_entries(id, edition) ON DELETE CASCADE,
  CONSTRAINT compendium_relations_not_self CHECK (source_entry_id <> target_entry_id),
  CONSTRAINT compendium_relations_unique UNIQUE (source_entry_id, target_entry_id, relation_type),
  CONSTRAINT compendium_relations_id_source_unique UNIQUE (id, source_entry_id)
);
CREATE INDEX IF NOT EXISTS compendium_relations_target_idx
  ON compendium_entry_relations(target_entry_id, relation_type);

CREATE TABLE IF NOT EXISTS compendium_import_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  generation_id uuid,
  ingestion_job_id uuid,
  status compendium_import_status NOT NULL DEFAULT 'pending',
  importer text NOT NULL,
  importer_version text NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_runs_file_source_fk FOREIGN KEY (file_id, source_id)
    REFERENCES files(id, source_id),
  CONSTRAINT compendium_import_runs_generation_owner_fk FOREIGN KEY (generation_id, file_id, source_id)
    REFERENCES ingestion_generations(id, file_id, source_id),
  CONSTRAINT compendium_import_runs_job_owner_fk FOREIGN KEY (ingestion_job_id, file_id, source_id)
    REFERENCES ingestion_jobs(id, file_id, source_id),
  CONSTRAINT compendium_import_runs_names_not_blank CHECK (btrim(importer) <> '' AND btrim(importer_version) <> ''),
  CONSTRAINT compendium_import_runs_timestamps CHECK (
    (status = 'pending' AND started_at IS NULL AND finished_at IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND finished_at IS NULL)
    OR (status IN ('succeeded', 'failed', 'cancelled') AND started_at IS NOT NULL AND finished_at IS NOT NULL)
  ),
  CONSTRAINT compendium_import_runs_id_source_file_unique UNIQUE (id, source_id, file_id),
  CONSTRAINT compendium_import_runs_generation_owner_unique UNIQUE (id, source_id, file_id, generation_id)
);
CREATE INDEX IF NOT EXISTS compendium_import_runs_source_created_idx
  ON compendium_import_runs(source_id, created_at DESC);

CREATE TABLE IF NOT EXISTS compendium_import_occurrences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_run_id uuid NOT NULL REFERENCES compendium_import_runs(id) ON DELETE CASCADE,
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  generation_id uuid,
  chunk_id uuid,
  occurrence_index integer NOT NULL,
  locator text NOT NULL,
  fingerprint_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_occurrences_run_owner_fk
    FOREIGN KEY (import_run_id, source_id, file_id)
    REFERENCES compendium_import_runs(id, source_id, file_id),
  CONSTRAINT compendium_import_occurrences_run_generation_fk
    FOREIGN KEY (import_run_id, source_id, file_id, generation_id)
    REFERENCES compendium_import_runs(id, source_id, file_id, generation_id),
  CONSTRAINT compendium_import_occurrences_generation_owner_fk
    FOREIGN KEY (generation_id, file_id, source_id)
    REFERENCES ingestion_generations(id, file_id, source_id),
  CONSTRAINT compendium_import_occurrences_chunk_owner_fk
    FOREIGN KEY (chunk_id, generation_id, file_id, source_id)
    REFERENCES chunks(id, generation_id, file_id, source_id),
  CONSTRAINT compendium_import_occurrences_chunk_generation CHECK (chunk_id IS NULL OR generation_id IS NOT NULL),
  CONSTRAINT compendium_import_occurrences_index_nonnegative CHECK (occurrence_index >= 0),
  CONSTRAINT compendium_import_occurrences_locator_not_blank CHECK (btrim(locator) <> ''),
  CONSTRAINT compendium_import_occurrences_fingerprint CHECK (fingerprint_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT compendium_import_occurrences_run_index_unique UNIQUE (import_run_id, occurrence_index),
  CONSTRAINT compendium_import_occurrences_id_source_file_unique UNIQUE (id, source_id, file_id)
);
CREATE INDEX IF NOT EXISTS compendium_import_occurrences_chunk_idx
  ON compendium_import_occurrences(chunk_id) WHERE chunk_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS compendium_import_occurrences_generation_idx
  ON compendium_import_occurrences(generation_id) WHERE generation_id IS NOT NULL;

CREATE OR REPLACE FUNCTION compendium_validate_occurrence_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE run_generation uuid;
BEGIN
  SELECT generation_id INTO run_generation FROM compendium_import_runs
  WHERE id = NEW.import_run_id AND source_id = NEW.source_id AND file_id = NEW.file_id
  FOR SHARE;
  IF NOT FOUND OR run_generation IS DISTINCT FROM NEW.generation_id THEN
    RAISE EXCEPTION 'import occurrence generation must exactly match its run generation';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_import_occurrences_generation_match ON compendium_import_occurrences;
CREATE TRIGGER compendium_import_occurrences_generation_match
BEFORE INSERT OR UPDATE ON compendium_import_occurrences
FOR EACH ROW EXECUTE FUNCTION compendium_validate_occurrence_generation();

CREATE OR REPLACE FUNCTION compendium_guard_import_run_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.generation_id IS DISTINCT FROM NEW.generation_id
     AND EXISTS (SELECT 1 FROM compendium_import_occurrences WHERE import_run_id = OLD.id) THEN
    RAISE EXCEPTION 'import run generation is immutable after its first occurrence';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_import_runs_generation_immutable ON compendium_import_runs;
CREATE TRIGGER compendium_import_runs_generation_immutable BEFORE UPDATE ON compendium_import_runs
FOR EACH ROW EXECUTE FUNCTION compendium_guard_import_run_generation();

CREATE TABLE IF NOT EXISTS compendium_import_links (
  occurrence_id uuid NOT NULL,
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  evidence_version_id uuid NOT NULL,
  evidence_entry_id uuid NOT NULL,
  revision_id uuid,
  relation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_import_links_occurrence_owner_fk
    FOREIGN KEY (occurrence_id, source_id, file_id)
    REFERENCES compendium_import_occurrences(id, source_id, file_id) ON DELETE CASCADE,
  CONSTRAINT compendium_import_links_version_owner_fk
    FOREIGN KEY (evidence_version_id, evidence_entry_id, source_id, file_id)
    REFERENCES compendium_versions(id, entry_id, source_id, file_id),
  CONSTRAINT compendium_import_links_revision_owner_fk
    FOREIGN KEY (revision_id, evidence_version_id)
    REFERENCES compendium_revisions(id, version_id),
  CONSTRAINT compendium_import_links_relation_owner_fk
    FOREIGN KEY (relation_id, evidence_entry_id)
    REFERENCES compendium_entry_relations(id, source_entry_id),
  CONSTRAINT compendium_import_links_one_target CHECK (num_nonnulls(revision_id, relation_id) <= 1),
  CONSTRAINT compendium_import_links_unique UNIQUE NULLS NOT DISTINCT
    (occurrence_id, evidence_version_id, revision_id, relation_id)
);
CREATE INDEX IF NOT EXISTS compendium_import_links_version_idx ON compendium_import_links(evidence_version_id);
CREATE INDEX IF NOT EXISTS compendium_import_links_revision_idx ON compendium_import_links(revision_id) WHERE revision_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS compendium_import_links_relation_idx ON compendium_import_links(relation_id) WHERE relation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS compendium_citations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL,
  version_id uuid NOT NULL,
  source_id uuid NOT NULL,
  file_id uuid NOT NULL,
  generation_id uuid NOT NULL,
  chunk_id uuid NOT NULL,
  kind compendium_citation_kind NOT NULL,
  field_path text,
  block_order integer NOT NULL DEFAULT 0,
  quote text NOT NULL,
  quote_span_start integer NOT NULL,
  quote_span_end integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT compendium_citations_revision_version_fk FOREIGN KEY (revision_id, version_id)
    REFERENCES compendium_revisions(id, version_id) ON DELETE CASCADE,
  CONSTRAINT compendium_citations_version_source_file_fk FOREIGN KEY (version_id, source_id, file_id)
    REFERENCES compendium_versions(id, source_id, file_id),
  CONSTRAINT compendium_citations_chunk_owner_fk FOREIGN KEY (chunk_id, generation_id, file_id, source_id)
    REFERENCES chunks(id, generation_id, file_id, source_id),
  CONSTRAINT compendium_citations_kind_path CHECK (
    (kind = 'field' AND field_path IS NOT NULL AND field_path ~ '^\$(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*$')
    OR (kind = 'block' AND field_path IS NULL)
  ),
  CONSTRAINT compendium_citations_order_nonnegative CHECK (block_order >= 0),
  CONSTRAINT compendium_citations_quote_not_blank CHECK (quote <> ''),
  CONSTRAINT compendium_citations_span_valid CHECK (
    quote_span_start >= 0 AND quote_span_end > quote_span_start
    AND quote_span_end - quote_span_start = char_length(quote)
  ),
  CONSTRAINT compendium_citations_order_unique UNIQUE NULLS NOT DISTINCT
    (revision_id, kind, field_path, block_order)
);
CREATE INDEX IF NOT EXISTS compendium_citations_chunk_idx ON compendium_citations(chunk_id);
CREATE INDEX IF NOT EXISTS compendium_citations_generation_idx ON compendium_citations(generation_id);
CREATE INDEX IF NOT EXISTS compendium_citations_revision_idx ON compendium_citations(revision_id, block_order);

-- Typed projections. extension_data is reserved for namespaced, non-core
-- fields; known browse/filter fields remain relational and constrained.
CREATE TABLE IF NOT EXISTS compendium_spells (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('spell'::compendium_entry_type) STORED,
  level smallint NOT NULL,
  school spell_school NOT NULL,
  casting_time text NOT NULL,
  range_text text NOT NULL,
  duration text NOT NULL,
  components text NOT NULL,
  concentration boolean NOT NULL DEFAULT false,
  ritual boolean NOT NULL DEFAULT false,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (level BETWEEN 0 AND 9),
  CHECK (btrim(casting_time) <> '' AND btrim(range_text) <> '' AND btrim(duration) <> '' AND btrim(components) <> ''),
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_spells_browse_idx ON compendium_spells(level, school);

CREATE TABLE IF NOT EXISTS compendium_creatures (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('creature'::compendium_entry_type) STORED,
  size creature_size NOT NULL,
  creature_type text NOT NULL,
  alignment text,
  armor_class smallint NOT NULL,
  hit_points integer NOT NULL,
  challenge_rating numeric(5,3) NOT NULL,
  speed text NOT NULL,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (btrim(creature_type) <> '' AND btrim(speed) <> ''),
  CHECK (armor_class BETWEEN 0 AND 50), CHECK (hit_points > 0),
  CHECK (challenge_rating IN (0, 0.125, 0.25, 0.5) OR challenge_rating BETWEEN 1 AND 30 AND challenge_rating = trunc(challenge_rating)),
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_creatures_browse_idx ON compendium_creatures(challenge_rating, creature_type);

CREATE TABLE IF NOT EXISTS compendium_items (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('item'::compendium_entry_type) STORED,
  category item_category NOT NULL,
  rarity item_rarity NOT NULL,
  requires_attunement boolean NOT NULL DEFAULT false,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_items_browse_idx ON compendium_items(category, rarity);

CREATE TABLE IF NOT EXISTS compendium_classes (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('class'::compendium_entry_type) STORED,
  hit_die smallint NOT NULL,
  primary_ability text NOT NULL,
  spellcasting_ability text,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (hit_die IN (6, 8, 10, 12)), CHECK (btrim(primary_ability) <> ''),
  CHECK (spellcasting_ability IS NULL OR btrim(spellcasting_ability) <> ''),
  CHECK (jsonb_typeof(extension_data) = 'object')
);

CREATE TABLE IF NOT EXISTS compendium_features (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('feature'::compendium_entry_type) STORED,
  level smallint NOT NULL,
  feature_kind text NOT NULL,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (level BETWEEN 1 AND 20), CHECK (btrim(feature_kind) <> ''),
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_features_browse_idx ON compendium_features(level, feature_kind);

CREATE TABLE IF NOT EXISTS compendium_species (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('species'::compendium_entry_type) STORED,
  size creature_size NOT NULL,
  speed integer NOT NULL,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (speed > 0), CHECK (jsonb_typeof(extension_data) = 'object')
);

CREATE TABLE IF NOT EXISTS compendium_backgrounds (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('background'::compendium_entry_type) STORED,
  ability_scores text NOT NULL,
  skill_proficiencies text NOT NULL,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (btrim(ability_scores) <> '' AND btrim(skill_proficiencies) <> ''),
  CHECK (jsonb_typeof(extension_data) = 'object')
);

CREATE TABLE IF NOT EXISTS compendium_feats (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('feat'::compendium_entry_type) STORED,
  category feat_category NOT NULL,
  prerequisite_level smallint,
  prerequisite_text text,
  repeatable boolean NOT NULL DEFAULT false,
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (prerequisite_level IS NULL OR prerequisite_level BETWEEN 1 AND 20),
  CHECK (prerequisite_text IS NULL OR btrim(prerequisite_text) <> ''),
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_feats_browse_idx ON compendium_feats(category, prerequisite_level);

CREATE TABLE IF NOT EXISTS compendium_equipment (
  revision_id uuid PRIMARY KEY,
  entry_type compendium_entry_type GENERATED ALWAYS AS ('equipment'::compendium_entry_type) STORED,
  category equipment_category NOT NULL,
  cost_cp integer,
  weight_lb numeric(10,3),
  extension_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY (revision_id, entry_type) REFERENCES compendium_revisions(id, entry_type) ON DELETE CASCADE,
  CHECK (cost_cp IS NULL OR cost_cp BETWEEN 0 AND 2147483647),
  CHECK (weight_lb IS NULL OR weight_lb BETWEEN 0 AND 9999999.999),
  CHECK (jsonb_typeof(extension_data) = 'object')
);
CREATE INDEX IF NOT EXISTS compendium_equipment_browse_idx ON compendium_equipment(category, cost_cp);

CREATE OR REPLACE FUNCTION compendium_guard_revision_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'compendium revisions are immutable';
  END IF;
  IF OLD.lifecycle = 'draft' AND NEW.lifecycle = 'published'
     AND NEW.published_at IS NOT NULL
     AND (to_jsonb(NEW) - 'lifecycle' - 'published_at') = (to_jsonb(OLD) - 'lifecycle' - 'published_at') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'compendium revisions are immutable except for draft publication';
END $$;
DROP TRIGGER IF EXISTS compendium_revisions_immutable ON compendium_revisions;
CREATE TRIGGER compendium_revisions_immutable BEFORE UPDATE OR DELETE ON compendium_revisions
FOR EACH ROW EXECUTE FUNCTION compendium_guard_revision_immutability();

CREATE OR REPLACE FUNCTION compendium_guard_version_boundary() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD.lifecycle = 'published' AND NEW.lifecycle = 'draft')
     OR (OLD.lifecycle = 'retired' AND NEW.lifecycle <> 'retired') THEN
    RAISE EXCEPTION 'compendium version lifecycle cannot move backwards';
  END IF;
  IF (NEW.entry_id, NEW.entry_type, NEW.edition, NEW.language, NEW.source_id, NEW.file_id)
     IS DISTINCT FROM
     (OLD.entry_id, OLD.entry_type, OLD.edition, OLD.language, OLD.source_id, OLD.file_id)
     AND EXISTS (SELECT 1 FROM compendium_revisions WHERE version_id = OLD.id) THEN
    RAISE EXCEPTION 'a version source and corpus boundary is immutable after its first revision';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_versions_boundary_immutable ON compendium_versions;
CREATE TRIGGER compendium_versions_boundary_immutable BEFORE UPDATE ON compendium_versions
FOR EACH ROW EXECUTE FUNCTION compendium_guard_version_boundary();

CREATE OR REPLACE FUNCTION compendium_revision_has_projection(revision uuid, revision_type compendium_entry_type)
RETURNS boolean LANGUAGE sql STABLE STRICT AS $$
  SELECT CASE revision_type
    WHEN 'spell' THEN EXISTS (SELECT 1 FROM compendium_spells WHERE revision_id = revision)
    WHEN 'creature' THEN EXISTS (SELECT 1 FROM compendium_creatures WHERE revision_id = revision)
    WHEN 'item' THEN EXISTS (SELECT 1 FROM compendium_items WHERE revision_id = revision)
    WHEN 'class' THEN EXISTS (SELECT 1 FROM compendium_classes WHERE revision_id = revision)
    WHEN 'feature' THEN EXISTS (SELECT 1 FROM compendium_features WHERE revision_id = revision)
    WHEN 'species' THEN EXISTS (SELECT 1 FROM compendium_species WHERE revision_id = revision)
    WHEN 'background' THEN EXISTS (SELECT 1 FROM compendium_backgrounds WHERE revision_id = revision)
    WHEN 'feat' THEN EXISTS (SELECT 1 FROM compendium_feats WHERE revision_id = revision)
    WHEN 'equipment' THEN EXISTS (SELECT 1 FROM compendium_equipment WHERE revision_id = revision)
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION compendium_validate_active_revision() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  target_version uuid;
  version_lifecycle compendium_version_lifecycle;
  active_revision uuid;
  active_type compendium_entry_type;
  active_lifecycle compendium_revision_lifecycle;
BEGIN
  target_version := CASE WHEN TG_TABLE_NAME = 'compendium_versions' THEN NEW.id ELSE NEW.version_id END;
  SELECT v.lifecycle, v.active_revision_id
    INTO version_lifecycle, active_revision
  FROM compendium_versions v WHERE v.id = target_version;
  IF NOT FOUND THEN RETURN NEW; END IF;

  SELECT r.entry_type, r.lifecycle INTO active_type, active_lifecycle
  FROM compendium_revisions r
  WHERE r.id = active_revision AND r.version_id = target_version;
  IF active_type IS NULL THEN
    RAISE EXCEPTION 'every compendium version requires its own active revision';
  END IF;
  IF (version_lifecycle = 'draft' AND active_lifecycle <> 'draft')
     OR (version_lifecycle IN ('published', 'retired') AND active_lifecycle <> 'published') THEN
    RAISE EXCEPTION 'active revision lifecycle must match its version lifecycle';
  END IF;
  IF NOT compendium_revision_has_projection(active_revision, active_type) THEN
    RAISE EXCEPTION 'an active revision requires its matching typed projection';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_versions_active_revision_valid ON compendium_versions;
CREATE CONSTRAINT TRIGGER compendium_versions_active_revision_valid
AFTER INSERT OR UPDATE ON compendium_versions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_active_revision();
DROP TRIGGER IF EXISTS compendium_revisions_active_revision_valid ON compendium_revisions;
CREATE CONSTRAINT TRIGGER compendium_revisions_active_revision_valid
AFTER INSERT OR UPDATE ON compendium_revisions DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION compendium_validate_active_revision();

CREATE OR REPLACE FUNCTION compendium_validate_citation_quote() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  chunk_quote text;
  generation_status text;
BEGIN
  SELECT c.quote_text, g.status INTO chunk_quote, generation_status
  FROM chunks c
  JOIN ingestion_generations g
    ON g.id = c.generation_id AND g.file_id = c.file_id AND g.source_id = c.source_id
  WHERE c.id = NEW.chunk_id AND c.generation_id = NEW.generation_id
    AND c.file_id = NEW.file_id AND c.source_id = NEW.source_id
  FOR SHARE OF c, g;
  IF generation_status NOT IN ('active', 'archived') THEN
    RAISE EXCEPTION 'citations require chunks from active or archived generations';
  END IF;
  IF chunk_quote IS NULL OR NEW.quote_span_end > char_length(chunk_quote)
     OR substring(chunk_quote FROM NEW.quote_span_start + 1
                  FOR NEW.quote_span_end - NEW.quote_span_start) <> NEW.quote THEN
    RAISE EXCEPTION 'citation quote and half-open span must exactly match the owned chunk quote_text';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS compendium_citations_exact_quote ON compendium_citations;
CREATE TRIGGER compendium_citations_exact_quote BEFORE INSERT OR UPDATE ON compendium_citations
FOR EACH ROW EXECUTE FUNCTION compendium_validate_citation_quote();

CREATE OR REPLACE FUNCTION compendium_guard_revision_children_immutability() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  old_revision uuid;
  new_revision uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (
      SELECT 1 FROM compendium_revisions r
      WHERE r.id = NEW.revision_id AND r.lifecycle = 'draft'
        AND r.created_at = transaction_timestamp()
    ) THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'revision children may only be inserted in the revision creation transaction';
  END IF;
  old_revision := OLD.revision_id;
  new_revision := CASE WHEN TG_OP = 'UPDATE' THEN NEW.revision_id ELSE NULL END;
  RAISE EXCEPTION 'revision children are immutable; old revision %, new revision %', old_revision, new_revision;
END $$;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'compendium_citations', 'compendium_spells', 'compendium_creatures', 'compendium_items',
    'compendium_classes', 'compendium_features', 'compendium_species', 'compendium_backgrounds',
    'compendium_feats', 'compendium_equipment'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS compendium_published_child_immutable ON %I', table_name);
    EXECUTE format('DROP TRIGGER IF EXISTS compendium_revision_child_immutable ON %I', table_name);
    EXECUTE format(
      'CREATE TRIGGER compendium_revision_child_immutable BEFORE INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION compendium_guard_revision_children_immutability()',
      table_name
    );
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION compendium_guard_cited_chunk() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM compendium_citations WHERE chunk_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'referenced citation chunk text and ownership are immutable';
    ELSIF (OLD.text, OLD.quote_text, OLD.generation_id, OLD.file_id, OLD.source_id)
          IS DISTINCT FROM (NEW.text, NEW.quote_text, NEW.generation_id, NEW.file_id, NEW.source_id) THEN
      RAISE EXCEPTION 'referenced citation chunk text and ownership are immutable';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS chunks_citation_immutable ON chunks;
CREATE TRIGGER chunks_citation_immutable BEFORE UPDATE OR DELETE ON chunks
FOR EACH ROW EXECUTE FUNCTION compendium_guard_cited_chunk();

CREATE OR REPLACE FUNCTION compendium_guard_cited_generation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM compendium_citations WHERE generation_id = OLD.id) THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'a cited generation cannot be deleted or returned to staged';
    ELSIF NEW.status IS DISTINCT FROM OLD.status
          AND NOT (OLD.status = 'active' AND NEW.status = 'archived') THEN
      RAISE EXCEPTION 'a cited generation only permits the active to archived transition';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
DROP TRIGGER IF EXISTS ingestion_generations_citation_lifecycle ON ingestion_generations;
CREATE TRIGGER ingestion_generations_citation_lifecycle BEFORE UPDATE OR DELETE ON ingestion_generations
FOR EACH ROW EXECUTE FUNCTION compendium_guard_cited_generation();

CREATE INDEX IF NOT EXISTS compendium_entries_browse_idx
  ON compendium_entries(entry_type, edition, canonical_key);
CREATE INDEX IF NOT EXISTS compendium_versions_browse_idx
  ON compendium_versions(entry_type, edition, language, lifecycle) INCLUDE (active_revision_id, source_id);
CREATE INDEX IF NOT EXISTS compendium_versions_source_idx ON compendium_versions(source_id, file_id);
CREATE INDEX IF NOT EXISTS compendium_revisions_version_created_idx
  ON compendium_revisions(version_id, revision_number DESC);
