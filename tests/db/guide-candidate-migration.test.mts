import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { MIGRATION_FILENAMES } from "../../src/server/db/migrations.ts";

const filename = "0016_compendium_guide_candidate_type.sql";
const sql = await readFile(`migrations/${filename}`, "utf8");

test("guide review candidates use a registered additive enum migration", () => {
  assert.equal(MIGRATION_FILENAMES.at(-1), filename);
  assert.match(sql, /ALTER TYPE compendium_entry_type ADD VALUE IF NOT EXISTS 'guide'/);
  assert.doesNotMatch(sql, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?compendium_(?:versions|revisions)\b/i);
});

test("guide migration remains ordered after simulated #79 and #86 merges", () => {
  const mergedOrder = [
    ...MIGRATION_FILENAMES.slice(0, -1),
    "0014_compendium_entry_editor.sql",
    "0015_spells_vertical_slice.sql",
    filename,
  ];
  assert.deepEqual(mergedOrder.slice(-3), [
    "0014_compendium_entry_editor.sql",
    "0015_spells_vertical_slice.sql",
    "0016_compendium_guide_candidate_type.sql",
  ]);
  assert.deepEqual(mergedOrder, [...mergedOrder].sort());
});
