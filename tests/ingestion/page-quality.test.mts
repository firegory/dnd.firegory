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

test("rejects long punctuation and digit garbage even when it has fewer than eight tokens", () => {
  const garbage = `${">=<=1234567890".repeat(30)} ${"!?=0987654321".repeat(30)}`;
  const quality = assessPageTextQuality(6, garbage, "ru");
  assert.equal(quality.status, "corrupt");
  assert.ok(quality.reasons.includes("long-non-text-garbage"));
  assert.ok(quality.reasons.includes("insufficient-letter-evidence"));
});

test("keeps short legitimate labels and numeric pages", () => {
  assert.equal(assessPageTextQuality(6, "Класс брони: 18", "ru").status, "good");
  assert.equal(assessPageTextQuality(7, "1 2 3 5 8 13 21 34", "ru").status, "good");
  assert.equal(assessPageTextQuality(8, "12345678901234567890 22345678901234567890 32345678901234567890 42345678901234567890 52345678901234567890 62345678901234567890", "ru").status, "good");
});

test("accepts coherent equation-heavy mathematical pages", () => {
  const equations = `
f(x) = x^2 + 2*x + 1
g(x) = (x^3 - 4*x) / (x + 2)
E = m*c^2
P(A|B) = P(B|A) * P(A) / P(B)
y = 3*x^4 - 2*x^2 + 7*x - 11
`;
  assert.equal(assessPageTextQuality(9, equations, "ru").status, "good");
});

test("accepts coherent matrices and numeric CSV tables", () => {
  const matrix = `
[ 1,  0, -2,  4 ]
[ 3,  5,  6, -1 ]
[ 0,  2,  1,  8 ]
[ 7, -3,  4,  2 ]
`;
  const csv = `
round,attack,damage,save
1,18,12.5,15
2,21,8.0,17
3,16,14.5,13
4,24,11.0,19
`;
  assert.equal(assessPageTextQuality(10, matrix, "ru").status, "good");
  assert.equal(assessPageTextQuality(11, csv, "ru").status, "good");
  assert.deepEqual(findPageQualityFailures({
    initiallyCorruptPages: new Set([10]),
    finalQuality: [assessPageTextQuality(10, matrix, "ru")],
    ocrAvailable: true,
    ocrReplacementPages: new Set([10]),
  }), []);
});

test("does not mistake adversarial operator noise for structured math", () => {
  const garbage = `${">=<=1234567890".repeat(25)}\n${"[[[=><=09876".repeat(25)}\n${"1,2,>=<=,[[[".repeat(25)}`;
  assert.equal(assessPageTextQuality(12, garbage, "ru").status, "corrupt");
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

test("rejects long OCR punctuation output with no proportional word evidence", () => {
  const punctuation = assessPageTextQuality(7, ">=<=1234567890".repeat(40), "ru");
  assert.match(findPageQualityFailures({
    initiallyCorruptPages: new Set([7]),
    finalQuality: [punctuation],
    ocrAvailable: true,
    ocrReplacementPages: new Set([7]),
  })[0].reason, /insufficient letter or word evidence/);
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
