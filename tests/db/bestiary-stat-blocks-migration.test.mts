import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

test("0018 adds the complete creature projection without changing flat or spell migration order", async () => {
  const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), "0021_nfs_exact_lookup_indexes.sql");
  assert.equal(MIGRATION_FILENAMES[MIGRATION_FILENAMES.indexOf("0017_flat_compendium_types.sql")+1], "0018_bestiary_stat_blocks.sql");
  assert.equal(MIGRATION_FILENAMES[MIGRATION_FILENAMES.indexOf("0018_bestiary_stat_blocks.sql")+1], "0019_class_species_hierarchy.sql");
  assert.equal(MIGRATION_FILENAMES.includes("0017_bestiary_stat_blocks.sql" as never), false);
  assert.ok(migrations.includes("0007_compendium_relational_core.sql"));
  assert.ok(migrations.includes("0015_spells_vertical_slice.sql"));
  const sql = await readFile("migrations/0018_bestiary_stat_blocks.sql", "utf8");
  assert.match(sql, /ALTER TABLE compendium_creatures/);
  assert.doesNotMatch(sql, /ALTER TABLE compendium_spells|DROP TABLE|DROP COLUMN/);
  for (const field of ["challenge_rating_numerator", "challenge_rating_denominator", "armor_classes", "hit_points_detail", "speeds", "abilities", "saves", "skills", "damage_resistances", "damage_immunities", "condition_immunities", "senses", "languages", "traits", "actions", "bonus_actions", "reactions", "legendary_actions"]) assert.match(sql, new RegExp(field));
  assert.match(sql, /challenge_rating = challenge_rating_numerator::numeric \/ challenge_rating_denominator/);
  assert.match(sql, /legacy_incomplete/);
  assert.doesNotMatch(sql, /passive_perception = coalesce|abilities = jsonb_build_object/);
  assert.match(sql, /item->>'mode' = ANY\(seen_modes\)/);
  for (const validator of ["hit_points", "modifiers", "blocks", "texts"]) assert.match(sql, new RegExp(`compendium_valid_creature_${validator}`));
  assert.match(sql, /new legacy_incomplete creature projections are not allowed/);
  assert.match(sql, /passive_perception IS NOT NULL AND passive_perception BETWEEN 0 AND 100/);
  assert.match(sql, /OLD\.projection_status = 'complete' AND NEW\.projection_status = 'legacy_incomplete'/);
  assert.match(sql, /BEFORE INSERT OR UPDATE OF projection_status ON compendium_creatures/);
  assert.doesNotMatch(sql, /OLD\.projection_status = 'legacy_incomplete' AND NEW\.projection_status = 'complete'[\s\S]*RAISE EXCEPTION/);
});
