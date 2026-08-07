-- Complete typed creature projection. 0017 remains reserved; existing flat and
-- spell migration order is intentionally unchanged.

ALTER TABLE compendium_creatures
  ADD COLUMN IF NOT EXISTS challenge_rating_numerator smallint,
  ADD COLUMN IF NOT EXISTS challenge_rating_denominator smallint,
  ADD COLUMN IF NOT EXISTS armor_classes jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS hit_points_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS speeds jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS abilities jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS saves jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS skills jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS damage_resistances text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS damage_immunities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS condition_immunities text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS senses text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS passive_perception smallint,
  ADD COLUMN IF NOT EXISTS languages text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN IF NOT EXISTS traits jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS bonus_actions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS legendary_actions jsonb NOT NULL DEFAULT '[]'::jsonb;

UPDATE compendium_creatures SET
  challenge_rating_numerator = CASE challenge_rating WHEN 0.125 THEN 1 WHEN 0.25 THEN 1 WHEN 0.5 THEN 1 ELSE challenge_rating::smallint END,
  challenge_rating_denominator = CASE challenge_rating WHEN 0.125 THEN 8 WHEN 0.25 THEN 4 WHEN 0.5 THEN 2 ELSE 1 END,
  armor_classes = CASE WHEN armor_classes = '[]'::jsonb THEN jsonb_build_array(jsonb_build_object('value', armor_class)) ELSE armor_classes END,
  hit_points_detail = CASE WHEN hit_points_detail = '{}'::jsonb THEN jsonb_build_object('average', hit_points) ELSE hit_points_detail END,
  speeds = CASE WHEN speeds = '[]'::jsonb THEN jsonb_build_array(jsonb_build_object('mode', 'walk', 'distance', coalesce(substring(speed from '(\d+)')::integer, 0), 'unit', 'ft')) ELSE speeds END,
  passive_perception = coalesce(passive_perception, 10)
WHERE challenge_rating_numerator IS NULL OR challenge_rating_denominator IS NULL OR passive_perception IS NULL;

ALTER TABLE compendium_creatures
  ALTER COLUMN challenge_rating_numerator SET NOT NULL,
  ALTER COLUMN challenge_rating_denominator SET NOT NULL,
  ALTER COLUMN passive_perception SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'compendium_creatures_complete_projection') THEN
    ALTER TABLE compendium_creatures ADD CONSTRAINT compendium_creatures_complete_projection CHECK (
      challenge_rating_denominator > 0
      AND challenge_rating = challenge_rating_numerator::numeric / challenge_rating_denominator
      AND jsonb_typeof(armor_classes) = 'array' AND jsonb_array_length(armor_classes) > 0
      AND jsonb_typeof(hit_points_detail) = 'object'
      AND jsonb_typeof(speeds) = 'array' AND jsonb_array_length(speeds) > 0
      AND jsonb_typeof(abilities) = 'object' AND jsonb_typeof(saves) = 'object' AND jsonb_typeof(skills) = 'object'
      AND jsonb_typeof(traits) = 'array' AND jsonb_typeof(actions) = 'array'
      AND jsonb_typeof(bonus_actions) = 'array' AND jsonb_typeof(reactions) = 'array' AND jsonb_typeof(legendary_actions) = 'array'
      AND passive_perception BETWEEN 0 AND 100
      AND array_position(damage_resistances, NULL) IS NULL AND array_position(damage_immunities, NULL) IS NULL
      AND array_position(condition_immunities, NULL) IS NULL AND array_position(senses, NULL) IS NULL AND array_position(languages, NULL) IS NULL
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS compendium_creatures_cr_exact_idx
  ON compendium_creatures (challenge_rating, creature_type, revision_id);
