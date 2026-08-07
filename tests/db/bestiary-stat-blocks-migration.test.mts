import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

test("0018 adds the complete creature projection without changing flat or spell migration order", async () => {
  const migrations = (await readdir("migrations")).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), "0018_bestiary_stat_blocks.sql");
  assert.ok(migrations.includes("0007_compendium_relational_core.sql"));
  assert.ok(migrations.includes("0015_spells_vertical_slice.sql"));
  const sql = await readFile("migrations/0018_bestiary_stat_blocks.sql", "utf8");
  assert.match(sql, /ALTER TABLE compendium_creatures/);
  assert.doesNotMatch(sql, /ALTER TABLE compendium_spells|DROP TABLE|DROP COLUMN/);
  for (const field of ["challenge_rating_numerator", "challenge_rating_denominator", "armor_classes", "hit_points_detail", "speeds", "abilities", "saves", "skills", "damage_resistances", "damage_immunities", "condition_immunities", "senses", "languages", "traits", "actions", "bonus_actions", "reactions", "legendary_actions"]) assert.match(sql, new RegExp(field));
  assert.match(sql, /challenge_rating = challenge_rating_numerator::numeric \/ challenge_rating_denominator/);
});
