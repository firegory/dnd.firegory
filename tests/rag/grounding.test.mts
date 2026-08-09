import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractiveFallback, groundGeneratedAnswer } from "../../src/server/rag/ground.ts";
import { parseLlmResponse } from "../../src/server/rag/format.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1", sourceId: "source-1", fileId: "file-1",
    text: "Lemure. Medium Fiend (Devil). Armor Class 7. Hit Points 13 (3d8). Speed 15 ft. Damage Immunities Fire, Poison.",
    quoteText: "Lemure. Medium Fiend (Devil). Armor Class 7. Hit Points 13 (3d8). Speed 15 ft. Damage Immunities Fire, Poison.",
    sectionHeading: "Lemure", pageNumber: 12, edition: "5e", language: "en",
    sourceTitle: "Open Rules", sourceCategory: "core_rules", accessTier: "open",
    score: 1, strategy: "keyword", ...overrides,
  };
}

describe("claim grounding", () => {
  it("renders a coherent Lemure stat answer with authoritative linked citations", () => {
    const result = groundGeneratedAnswer({ claims: [
      { text: "The Lemure is a Medium Fiend Devil.", references: ["C1"] },
      { text: "Lemure AC is 7.", references: ["C1"] },
      { text: "Lemure Hit Points are 13.", references: ["C1"] },
      { text: "Its Speed is 15 feet.", references: ["C1"] },
      { text: "Damage Immunities are Fire and Poison.", references: ["C1"] },
    ], rejected: false }, [chunk()], "en");

    assert.equal(result.claims.length, 5);
    assert.match(result.answer, /Medium Fiend Devil/);
    assert.match(result.answer, /Speed is 15 feet/);
    assert.equal(result.claims[0].citations[0].quote, chunk().quoteText);
    assert.equal(result.claims[0].citations[0].page, 12);
    assert.equal(result.confident, true);
  });

  it("omits a laundered fire-immunity claim backed only by AC evidence", () => {
    const acChunk = chunk({ quoteText: "Lemure. Armor Class 7." });
    const result = groundGeneratedAnswer({ claims: [
      { text: "The Lemure has Fire Immunity.", references: ["C1"] },
      { text: "Lemure Armor Class is 7.", references: ["C1"] },
    ], rejected: false }, [acChunk], "en");
    assert.equal(result.answer, "Lemure Armor Class is 7.");
    assert.equal(result.claims.length, 1);
    assert.equal(result.confident, false);
  });

  it("rejects the whole claim when one reference is valid and another is invented", () => {
    const result = groundGeneratedAnswer({ claims: [
      { text: "Lemure Armor Class is 7.", references: ["C1", "C2"] },
      { text: "Lemure Hit Points are 13.", references: ["C1"] },
    ], rejected: false }, [chunk()], "en");
    assert.equal(result.answer, "Lemure Hit Points are 13.");
    assert.equal(result.confident, false);
  });

  it("requires one referenced context to support the whole claim instead of combining contexts", () => {
    const fire = chunk({ chunkId: "fire", quoteText: "Lemure is resistant to fire." });
    const poison = chunk({ chunkId: "poison", sectionHeading: "Imp", quoteText: "Imp is not resistant to poison." });
    const result = groundGeneratedAnswer({ claims: [
      { text: "Lemure is not resistant to poison.", references: ["C1", "C2"] },
      { text: "Lemure is resistant to fire.", references: ["C1", "C2"] },
    ], rejected: false }, [fire, poison], "en");
    assert.equal(result.answer, "Lemure is resistant to fire.");
    assert.equal(result.claims[0].citations.length, 2);
    assert.equal(result.confident, false);
  });

  it("rejects quote-prefix laundering as an unknown claim field", () => {
    const parsed = parseLlmResponse(JSON.stringify({ claims: [{
      text: "The Lemure has Fire Immunity.", references: ["C1"], quote: "Lemure. Armor Class 7. Fire",
    }] }));
    const result = groundGeneratedAnswer(parsed, [chunk({ quoteText: "Lemure. Armor Class 7." })], "en");
    assert.equal(parsed.rejected, true);
    assert.equal(result.claims.length, 0);
    assert.equal(result.confident, false);
  });

  it("retains valid Russian synthesis and rejects invented Russian content", () => {
    const ruChunk = chunk({
      quoteText: "Лемур. Класс Доспеха 7. Хиты 13.", sectionHeading: "Лемур",
      language: "ru", sourceTitle: "Открытые правила",
    });
    const result = groundGeneratedAnswer({ claims: [
      { text: "Лемур: Класс Доспеха 7.", references: ["C1"] },
      { text: "Лемур: Хиты 13.", references: ["C1"] },
      { text: "Лемур имеет иммунитет к огню.", references: ["C1"] },
    ], rejected: false }, [ruChunk], "ru");
    assert.equal(result.answer, "Лемур: Класс Доспеха 7.\n\nЛемур: Хиты 13.");
    assert.equal(result.confident, false);
  });

  it("falls back to three cleaned, bounded excerpts for zero claims or provider failure", () => {
    const dirty = chunk({ quoteText: `  Lemure\n\n${"Armor ".repeat(150)}` });
    const result = groundGeneratedAnswer(parseLlmResponse("not json"), [dirty, chunk({ chunkId: "2" }), chunk({ chunkId: "3" }), chunk({ chunkId: "4" })], "en");
    assert.match(result.answer, /summary is unavailable/);
    assert.equal(result.claims.length, 0);
    assert.equal(result.citations.length, 3);
    assert.ok(result.citations[0].quote.length <= 600);
    assert.doesNotMatch(result.citations[0].quote, /\n|\s{2}/);
    assert.equal(extractiveFallback("en", [chunk()]).confident, false);
  });
});
