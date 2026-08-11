import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractiveFallback, groundGeneratedAnswer } from "../../src/server/rag/ground.ts";
import { parseLlmResponse } from "../../src/server/rag/format.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1", sourceId: "source-1", fileId: "file-1",
    text: "Lemure. Armor Class 7. Hit Points 13. Speed 15 ft.",
    quoteText: "Lemure. Armor Class 7. Hit Points 13. Speed 15 ft.",
    sectionHeading: "Lemure", pageNumber: 12, edition: "5e", language: "en",
    sourceTitle: "Open Rules", sourceCategory: "core_rules", accessTier: "open",
    score: 1, strategy: "keyword", ...overrides,
  };
}

describe("authoritative segment grounding", () => {
  it("renders only exact selected server text and linked metadata", () => {
    const result = groundGeneratedAnswer(parseLlmResponse('{"selections":["C1:S2","C1:S4"]}'), [chunk()], "en");
    assert.equal(result.answer, "Armor Class 7.\n\nSpeed 15 ft.");
    assert.deepEqual(result.claims.map((claim) => claim.text), ["Armor Class 7.", "Speed 15 ft."]);
    assert.equal(result.claims[0].citations[0].quote, "Armor Class 7.");
    assert.equal(result.claims[0].citations[0].page, 12);
    assert.equal(result.confident, true);
    assert.equal(result.fallbackReason, null);
  });

  it("cannot reassign entities, relationships, negation, comparisons, or stats with model prose", () => {
    const attacks = [
      { selections: ["C1:S1"], text: "Imp Armor Class is 7." },
      { selections: ["C1:S1"], text: "Lemure follows Imp." },
      { selections: ["C1:S1"], text: "Lemure is not resistant." },
      { selections: ["C1:S1"], text: "Lemure has higher AC than Imp." },
      { selections: ["C1:S1"], text: "Lemure Hit Points are 7." },
    ];
    for (const attack of attacks) {
      const result = groundGeneratedAnswer(parseLlmResponse(JSON.stringify(attack)), [chunk()], "en");
      assert.equal(result.claims.length, 0);
      assert.equal(result.fallbackReason, "malformed_selection");
      assert.doesNotMatch(result.answer, /Imp|follows|resistant|higher|Hit Points are 7/);
    }
  });

  it("fails the whole response closed for one unknown cross-source selection", () => {
    const result = groundGeneratedAnswer(
      parseLlmResponse('{"selections":["C1:S2","C2:S99"]}'),
      [chunk(), chunk({ chunkId: "chunk-2", quoteText: "Imp. Armor Class 13." })],
      "en",
    );
    assert.equal(result.claims.length, 0);
    assert.equal(result.fallbackReason, "malformed_selection");
  });

  it("preserves exact Russian and complete table-row selections", () => {
    const ru = chunk({
      quoteText: "Лемур не имеет иммунитета к холоду.\nЛемур | КД 7 | Хиты 13 | Скорость 15 футов",
      language: "ru", sourceTitle: "Открытые правила",
    });
    const result = groundGeneratedAnswer(parseLlmResponse('{"selections":["C1:S1","C1:S2"]}'), [ru], "ru");
    assert.equal(result.answer, "Лемур не имеет иммунитета к холоду.\n\nЛемур | КД 7 | Хиты 13 | Скорость 15 футов");
    assert.equal(result.citations[1].quote, "Лемур | КД 7 | Хиты 13 | Скорость 15 футов");
  });

  it("deduplicates and orders selections but lowers confidence", () => {
    const result = groundGeneratedAnswer(
      parseLlmResponse('{"selections":["C1:S3","C1:S2","C1:S2"]}'), [chunk()], "en",
    );
    assert.equal(result.answer, "Armor Class 7.\n\nHit Points 13.");
    assert.equal(result.confident, false);
    assert.equal(result.fallbackReason, "selection_normalized");
  });

  it("preserves one exact authorized fallback excerpt per source with accurate labels", () => {
    const chunks = [
      chunk({ chunkId: "one", sourceTitle: "One", quoteText: "  First exact excerpt.  Another sentence." }),
      chunk({ chunkId: "two", sourceTitle: "Two", quoteText: "Second exact excerpt." }),
      chunk({ chunkId: "three", sourceTitle: "Three", quoteText: "Third exact excerpt." }),
      chunk({ chunkId: "four", sourceTitle: "Four", quoteText: "Fourth exact excerpt." }),
    ];
    const result = extractiveFallback("en", chunks, "provider_unavailable");
    assert.deepEqual(result.citations.map(({ quote, sourceTitle }) => ({ quote, sourceTitle })), [
      { quote: "First exact excerpt.", sourceTitle: "One" },
      { quote: "Second exact excerpt.", sourceTitle: "Two" },
      { quote: "Third exact excerpt.", sourceTitle: "Three" },
    ]);
    assert.equal(result.fallbackReason, "provider_unavailable");
    assert.equal(result.confident, false);
  });

  it("reports safe validation fallback reasons without returning provider content", () => {
    const source = chunk({ quoteText: "Lemure. Armor Class 7." });
    const malformed = groundGeneratedAnswer(parseLlmResponse("provider leaked prose"), [source], "en");
    const empty = groundGeneratedAnswer(parseLlmResponse('{"selections":[]}'), [source], "en");

    assert.equal(malformed.fallbackReason, "malformed_selection");
    assert.equal(empty.fallbackReason, "no_selection");
    assert.doesNotMatch(malformed.answer, /provider leaked prose/);
    assert.deepEqual(malformed.citations.map((citation) => citation.quote), ["Lemure."]);
  });
});
