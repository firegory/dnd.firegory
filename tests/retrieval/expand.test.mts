import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  expandQuery,
  combinedExpandedQuery,
} from "../../src/server/retrieval/expand.ts";

describe("expandQuery", () => {
  it("returns original query when disabled", () => {
    const result = expandQuery("armor class", { enabled: false });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].text, "armor class");
    assert.strictEqual(result[0].reason, "original");
  });

  it("returns original query for empty input", () => {
    const result = expandQuery("");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].text, "");
  });

  it("returns original query for whitespace input", () => {
    const result = expandQuery("   ");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].text, "   ");
  });

  it("returns original for query with no known aliases", () => {
    const result = expandQuery("fireball magic rules");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].reason, "original");
  });

  it("does not match aliases as substrings", () => {
    // "description" contains "con" as substring but should NOT trigger constitution alias
    const result = expandQuery("fireball spell description");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].reason, "original");

    // "index" contains "dex" as substring but should NOT trigger dexterity alias
    const result2 = expandQuery("index of spells");
    assert.strictEqual(result2.length, 1);
    assert.strictEqual(result2[0].reason, "original");

    // "character" contains "cha" as substring but should NOT trigger charisma alias
    const result3 = expandQuery("character creation");
    assert.strictEqual(result3.length, 1);
    assert.strictEqual(result3[0].reason, "original");
  });

  it("expands ac alias to armor class", () => {
    const result = expandQuery("ac modifier");
    assert.ok(result.length >= 2);
    const texts = result.map((r) => r.text.toLowerCase());
    assert.ok(texts.includes("armor class"));
    assert.ok(result.some((r) => r.reason === "alias"));
  });

  it("expands hp alias to hit points", () => {
    const result = expandQuery("hp maximum");
    const texts = result.map((r) => r.text.toLowerCase());
    assert.ok(texts.includes("hit points"));
  });

  it("expands multiple aliases in one query", () => {
    const result = expandQuery("ac and hp");
    const texts = result.map((r) => r.text.toLowerCase());
    assert.ok(texts.includes("armor class"));
    assert.ok(texts.includes("hit points"));
  });

  it("does not add bilingual terms when disabled", () => {
    const result = expandQuery("armor class", { bilingual: false });
    const texts = result.map((r) => r.text);
    assert.ok(!texts.includes("класс брони"));
  });

  it("adds bilingual terms when enabled for English query", () => {
    const result = expandQuery("armor class", { bilingual: true });
    const texts = result.map((r) => r.text);
    assert.ok(texts.includes("класс брони"));
    assert.ok(result.some((r) => r.reason === "bilingual"));
  });

  it("adds bilingual terms for Russian query when enabled", () => {
    const result = expandQuery("хиты", { bilingual: true });
    const texts = result.map((r) => r.text);
    assert.ok(texts.includes("hit points"));
  });

  it("expands fuzzy Russian Druid sea subclass wording", () => {
    const result = expandQuery("подкласс с морским вайбом у друида", {
      bilingual: true,
    });
    const texts = result.map((r) => r.text.toLowerCase());

    assert.ok(texts.includes("subclass"));
    assert.ok(texts.includes("druid"));
    assert.ok(texts.includes("circle of the sea"));
  });

  it("does not duplicate already-present terms", () => {
    const result = expandQuery("hit points", { bilingual: true });
    // "hit points" should appear only once as original, not again as alias
    const hpEntries = result.filter(
      (r) => r.text.toLowerCase() === "hit points",
    );
    assert.strictEqual(hpEntries.length, 1);
    assert.strictEqual(hpEntries[0].reason, "original");
  });

  it("sets appropriate weights for different expansion types", () => {
    const result = expandQuery("ac", { bilingual: true });
    const original = result.find((r) => r.reason === "original");
    const alias = result.find((r) => r.reason === "alias");
    const bilingual = result.find((r) => r.reason === "bilingual");

    assert.ok(original);
    assert.strictEqual(original.weight, 1.0);

    if (alias) {
      assert.strictEqual(alias.weight, 0.8);
    }
    if (bilingual) {
      assert.strictEqual(bilingual.weight, 0.7);
    }
  });

  it("expands ability score abbreviations", () => {
    const strResult = expandQuery("str check");
    assert.ok(strResult.some((r) => r.text === "strength"));

    const dexResult = expandQuery("dex save");
    assert.ok(dexResult.some((r) => r.text === "dexterity"));

    const conResult = expandQuery("con modifier");
    assert.ok(conResult.some((r) => r.text === "constitution"));

    const intResult = expandQuery("int ability");
    assert.ok(intResult.some((r) => r.text === "intelligence"));

    const wisResult = expandQuery("wis check");
    assert.ok(wisResult.some((r) => r.text === "wisdom"));

    const chaResult = expandQuery("cha modifier");
    assert.ok(chaResult.some((r) => r.text === "charisma"));
  });
});

describe("combinedExpandedQuery", () => {
  it("returns empty string for empty input", () => {
    assert.strictEqual(combinedExpandedQuery([]), "");
  });

  it("returns single query text as-is", () => {
    const result = combinedExpandedQuery([
      { text: "fireball", reason: "original", weight: 1.0 },
    ]);
    assert.strictEqual(result, "fireball");
  });

  it("joins multiple expansions with websearch OR", () => {
    const result = combinedExpandedQuery([
      { text: "ac", reason: "original", weight: 1.0 },
      { text: "armor class", reason: "alias", weight: 0.8 },
    ]);
    assert.strictEqual(result, "ac OR armor class");
  });
});
