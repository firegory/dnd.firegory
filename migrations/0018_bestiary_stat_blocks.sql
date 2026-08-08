-- Complete typed creature projection. 0017 remains reserved; existing flat and
-- spell migration order is intentionally unchanged. Existing creature rows are
-- marked incomplete: this migration never invents absent stat-block values.

ALTER TABLE compendium_creatures
  ADD COLUMN IF NOT EXISTS projection_status text NOT NULL DEFAULT 'legacy_incomplete',
  ADD COLUMN IF NOT EXISTS challenge_rating_numerator smallint,
  ADD COLUMN IF NOT EXISTS challenge_rating_denominator smallint,
  ADD COLUMN IF NOT EXISTS armor_classes jsonb,
  ADD COLUMN IF NOT EXISTS hit_points_detail jsonb,
  ADD COLUMN IF NOT EXISTS speeds jsonb,
  ADD COLUMN IF NOT EXISTS abilities jsonb,
  ADD COLUMN IF NOT EXISTS saves jsonb,
  ADD COLUMN IF NOT EXISTS skills jsonb,
  ADD COLUMN IF NOT EXISTS damage_resistances text[],
  ADD COLUMN IF NOT EXISTS damage_immunities text[],
  ADD COLUMN IF NOT EXISTS condition_immunities text[],
  ADD COLUMN IF NOT EXISTS senses text[],
  ADD COLUMN IF NOT EXISTS passive_perception smallint,
  ADD COLUMN IF NOT EXISTS languages text[],
  ADD COLUMN IF NOT EXISTS traits jsonb,
  ADD COLUMN IF NOT EXISTS actions jsonb,
  ADD COLUMN IF NOT EXISTS bonus_actions jsonb,
  ADD COLUMN IF NOT EXISTS reactions jsonb,
  ADD COLUMN IF NOT EXISTS legendary_actions jsonb;

ALTER TABLE compendium_creatures ALTER COLUMN projection_status SET DEFAULT 'complete';

-- CR is already persisted evidence and can be represented exactly. No other
-- missing field is synthesized for legacy rows.
UPDATE compendium_creatures SET
  challenge_rating_numerator = CASE challenge_rating WHEN 0.125 THEN 1 WHEN 0.25 THEN 1 WHEN 0.5 THEN 1 ELSE challenge_rating::smallint END,
  challenge_rating_denominator = CASE challenge_rating WHEN 0.125 THEN 8 WHEN 0.25 THEN 4 WHEN 0.5 THEN 2 ELSE 1 END
WHERE challenge_rating_numerator IS NULL OR challenge_rating_denominator IS NULL;

CREATE OR REPLACE FUNCTION compendium_valid_creature_armor(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ? 'value') OR item - 'value' - 'note' <> '{}'::jsonb
       OR jsonb_typeof(item->'value') <> 'number' OR (item->>'value')::numeric <> trunc((item->>'value')::numeric)
       OR (item->>'value')::numeric NOT BETWEEN 1 AND 50
       OR (item ? 'note' AND (jsonb_typeof(item->'note') <> 'string' OR btrim(item->>'note') = '' OR length(item->>'note') > 200)) THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_speeds(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE item jsonb;
DECLARE seen_modes text[] := '{}';
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 8 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ?& ARRAY['mode','distance','unit']) OR item - 'mode' - 'distance' - 'unit' - 'note' <> '{}'::jsonb
       OR jsonb_typeof(item->'mode') <> 'string' OR item->>'mode' NOT IN ('walk','burrow','climb','fly','swim')
       OR item->>'mode' = ANY(seen_modes) OR jsonb_typeof(item->'unit') <> 'string' OR item->>'unit' NOT IN ('ft','m')
       OR jsonb_typeof(item->'distance') <> 'number' OR (item->>'distance')::numeric <> trunc((item->>'distance')::numeric)
       OR (item->>'distance')::numeric NOT BETWEEN 1 AND 10000
       OR (item ? 'note' AND (jsonb_typeof(item->'note') <> 'string' OR btrim(item->>'note') = '' OR length(item->>'note') > 200)) THEN RETURN false; END IF;
    seen_modes := array_append(seen_modes, item->>'mode');
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_hit_points(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
BEGIN
  RETURN jsonb_typeof(value) = 'object' AND value ? 'average' AND value - 'average' - 'formula' = '{}'::jsonb
    AND jsonb_typeof(value->'average') = 'number'
    AND (value->>'average')::numeric = trunc((value->>'average')::numeric)
    AND (value->>'average')::numeric BETWEEN 1 AND 2147483647
    AND (NOT (value ? 'formula') OR (jsonb_typeof(value->'formula') = 'string'
      AND value->>'formula' ~* '^\d+d\d+(?:\s*[+-]\s*\d+)?$' AND length(value->>'formula') <= 40));
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_modifiers(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE modifier record;
BEGIN
  IF jsonb_typeof(value) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(value)) > 100 THEN RETURN false; END IF;
  FOR modifier IN SELECT * FROM jsonb_each(value) LOOP
    IF btrim(modifier.key) = '' OR length(modifier.key) > 100 OR jsonb_typeof(modifier.value) <> 'number'
       OR (modifier.value #>> '{}')::numeric <> trunc((modifier.value #>> '{}')::numeric)
       OR (modifier.value #>> '{}')::numeric NOT BETWEEN -30 AND 30 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_blocks(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE item jsonb;
BEGIN
  IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) > 100 THEN RETURN false; END IF;
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ?& ARRAY['name','text']) OR item - 'name' - 'text' <> '{}'::jsonb
       OR jsonb_typeof(item->'name') <> 'string' OR btrim(item->>'name') = '' OR length(item->>'name') > 300
       OR jsonb_typeof(item->'text') <> 'string' OR btrim(item->>'text') = '' OR length(item->>'text') > 10000 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_texts(value text[]) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE item text;
BEGIN
  IF cardinality(value) > 100 OR array_position(value, NULL) IS NOT NULL THEN RETURN false; END IF;
  FOREACH item IN ARRAY value LOOP
    IF btrim(item) = '' OR length(item) > 500 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION compendium_valid_creature_abilities(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE AS $$
DECLARE ability record;
BEGIN
  IF jsonb_typeof(value) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 6 OR NOT (value ?& ARRAY['str','dex','con','int','wis','cha']) THEN RETURN false; END IF;
  FOR ability IN SELECT * FROM jsonb_each(value) LOOP
    IF jsonb_typeof(ability.value) <> 'number' OR (ability.value #>> '{}')::numeric <> trunc((ability.value #>> '{}')::numeric)
       OR (ability.value #>> '{}')::numeric NOT BETWEEN 1 AND 30 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_creatures_projection_status') THEN
    ALTER TABLE compendium_creatures ADD CONSTRAINT compendium_creatures_projection_status
      CHECK (projection_status IN ('legacy_incomplete', 'complete'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_creatures_complete_projection') THEN
    ALTER TABLE compendium_creatures ADD CONSTRAINT compendium_creatures_complete_projection CHECK (
      projection_status = 'legacy_incomplete'
      OR (
        challenge_rating_numerator IS NOT NULL AND challenge_rating_denominator IS NOT NULL
        AND armor_classes IS NOT NULL AND hit_points_detail IS NOT NULL AND speeds IS NOT NULL AND abilities IS NOT NULL
        AND saves IS NOT NULL AND skills IS NOT NULL AND traits IS NOT NULL AND actions IS NOT NULL
        AND bonus_actions IS NOT NULL AND reactions IS NOT NULL AND legendary_actions IS NOT NULL
        AND (challenge_rating_numerator, challenge_rating_denominator) IN ((0,1),(1,8),(1,4),(1,2),
          (1,1),(2,1),(3,1),(4,1),(5,1),(6,1),(7,1),(8,1),(9,1),(10,1),
          (11,1),(12,1),(13,1),(14,1),(15,1),(16,1),(17,1),(18,1),(19,1),(20,1),
          (21,1),(22,1),(23,1),(24,1),(25,1),(26,1),(27,1),(28,1),(29,1),(30,1))
        AND challenge_rating = challenge_rating_numerator::numeric / challenge_rating_denominator
        AND compendium_valid_creature_armor(armor_classes)
        AND compendium_valid_creature_hit_points(hit_points_detail)
        AND compendium_valid_creature_speeds(speeds)
        AND compendium_valid_creature_abilities(abilities)
        AND compendium_valid_creature_modifiers(saves) AND compendium_valid_creature_modifiers(skills)
        AND damage_resistances IS NOT NULL AND damage_immunities IS NOT NULL AND condition_immunities IS NOT NULL
        AND senses IS NOT NULL AND languages IS NOT NULL AND passive_perception BETWEEN 0 AND 100
        AND compendium_valid_creature_blocks(traits) AND compendium_valid_creature_blocks(actions)
        AND compendium_valid_creature_blocks(bonus_actions) AND compendium_valid_creature_blocks(reactions)
        AND compendium_valid_creature_blocks(legendary_actions)
        AND compendium_valid_creature_texts(damage_resistances) AND compendium_valid_creature_texts(damage_immunities)
        AND compendium_valid_creature_texts(condition_immunities) AND compendium_valid_creature_texts(senses)
        AND compendium_valid_creature_texts(languages)
      )
    );
  END IF;
END $$;

-- Rows that predate this migration remain editable and may be completed by an
-- UPDATE, but no application path may create another incomplete projection.
CREATE OR REPLACE FUNCTION compendium_reject_new_legacy_creature() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.projection_status = 'legacy_incomplete' THEN
    RAISE EXCEPTION 'new legacy_incomplete creature projections are not allowed';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS compendium_creatures_reject_new_legacy ON compendium_creatures;
CREATE TRIGGER compendium_creatures_reject_new_legacy
BEFORE INSERT ON compendium_creatures
FOR EACH ROW EXECUTE FUNCTION compendium_reject_new_legacy_creature();

CREATE INDEX IF NOT EXISTS compendium_creatures_cr_exact_idx
  ON compendium_creatures (challenge_rating, creature_type, revision_id);
