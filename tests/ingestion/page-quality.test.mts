import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assessPageTextQuality,
  findPageQualityFailures,
} from "../../src/worker/ingestion/page-quality.ts";

const corruptFixture = await readFile(
  "tests/fixtures/ingestion/corrupt-russian-text-layer.txt",
  "utf8",
);
const validRussian = `
Книга заклинаний волшебника содержит описания известных ему заклинаний.
На каждом уровне персонаж может подготовить несколько заклинаний и применить
их, используя ячейки соответствующего уровня. Сложность спасброска равна 15.
`;

test("detects the supplied broken custom-font Russian text layer", () => {
  const quality = assessPageTextQuality(7, corruptFixture, "ru");
  assert.equal(quality.status, "corrupt");
  assert.ok(quality.reasons.includes("punctuation-or-digit-intrusion"));
  assert.ok(quality.reasons.includes("failed-word-shape"));
});

test("does not flag valid Russian or mixed Russian and English", () => {
  assert.equal(assessPageTextQuality(1, validRussian, "ru").status, "good");
  assert.equal(assessPageTextQuality(2, `${validRussian}\nSpellcasting Ability: Intelligence. Armor Class: 16.`, "ru").status, "good");
});

test("does not flag English passages declared as part of a Russian source", () => {
  const text = "The creature makes two melee attacks. On a successful saving throw, the target takes half damage and remains standing. ".repeat(3);
  assert.equal(assessPageTextQuality(3, text, "ru").status, "good");
});

test("does not flag D&D stat tables, numbers, or code", () => {
  const table = `
STR 18 (+4)  DEX 14 (+2)  CON 16 (+3)  INT 10 (+0)  WIS 12 (+1)  CHA 8 (-1)
Armor Class 17 (natural armor)  Hit Points 95 (10d10 + 40)  Speed 30 ft., fly 60 ft.
Challenge 7 (2,900 XP)  Proficiency Bonus +3  Saving Throws Dex +5, Con +6
`;
  const code = `const attackBonus = ability + proficiency;\nif (target.ac <= roll) { return damage.roll("2d6+3"); }\n`.repeat(3);
  assert.equal(assessPageTextQuality(4, table, "ru").status, "good");
  assert.equal(assessPageTextQuality(5, code, "ru").status, "good");
});

test("fails closed when forced OCR is unavailable or remains corrupt", () => {
  const corrupt = assessPageTextQuality(7, corruptFixture, "ru");
  assert.match(findPageQualityFailures({
    initiallyCorruptPages: new Set([7]),
    finalQuality: [corrupt],
    ocrAvailable: false,
    ocrReplacementPages: new Set(),
  })[0].reason, /unavailable/);
  assert.match(findPageQualityFailures({
    initiallyCorruptPages: new Set([7]),
    finalQuality: [corrupt],
    ocrAvailable: true,
    ocrReplacementPages: new Set([7]),
  })[0].reason, /remains corrupt/);
});

test("rejects OCR output too short to receive language quality scoring", () => {
  const short = assessPageTextQuality(7, "Книга", "ru");
  assert.match(findPageQualityFailures({
    initiallyCorruptPages: new Set([7]),
    finalQuality: [short],
    ocrAvailable: true,
    ocrReplacementPages: new Set(),
  })[0].reason, /no replacement text/);
});

test("accepts a forced OCR replacement only after it passes re-scoring", () => {
  const clean = assessPageTextQuality(7, validRussian, "ru");
  assert.deepEqual(findPageQualityFailures({
    initiallyCorruptPages: new Set([7]),
    finalQuality: [clean],
    ocrAvailable: true,
    ocrReplacementPages: new Set([7]),
  }), []);
});
