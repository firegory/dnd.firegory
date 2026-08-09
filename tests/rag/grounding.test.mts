import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { extractiveFallback, groundGeneratedAnswer } from "../../src/server/rag/ground.ts";
import { parseLlmResponse, type RawLlmCitation } from "../../src/server/rag/format.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1", sourceId: "source-1", fileId: "file-1",
    text: "Armor Class 18. Speed 30 ft. Hit Points 45.",
    quoteText: "Armor Class 18. Speed 30 ft. Hit Points 45.",
    sectionHeading: "Guardian", pageNumber: 12, edition: "5e", language: "en",
    sourceTitle: "Open Rules", sourceCategory: "core_rules", accessTier: "open",
    score: 1, strategy: "keyword", ...overrides,
  };
}

function ref(overrides: Partial<RawLlmCitation> = {}): RawLlmCitation {
  return {
    contextId: "C1", quote: "Armor Class 18", sourceTitle: "Open Rules",
    edition: "5e", language: "en", page: 12, section: "Guardian", ...overrides,
  };
}

describe("claim grounding", () => {
  it("returns a valid paraphrase with claim-to-citation linkage", () => {
    const result = groundGeneratedAnswer({
      claims: [{ text: "The guardian's Armor Class is 18.", citations: [ref()] }],
      rejected: false,
    }, [chunk()], "en");
    assert.equal(result.answer, "The guardian's Armor Class is 18.");
    assert.equal(result.claims[0].citations[0].chunkId, "chunk-1");
    assert.equal(result.confident, true);
  });

  it("omits an uncited claim even when another claim has a valid citation", () => {
    const parsed = parseLlmResponse(JSON.stringify({ claims: [
      { text: "It is immune to fire.", citations: [] },
      { text: "Its Armor Class is 18.", citations: [ref()] },
    ] }));
    const result = groundGeneratedAnswer(parsed, [chunk()], "en");
    assert.equal(result.answer, "Its Armor Class is 18.");
    assert.doesNotMatch(result.answer, /immune/);
    assert.equal(result.confident, false);
  });

  it("does not let a valid citation elsewhere legitimize an unrelated claim", () => {
    const result = groundGeneratedAnswer({
      claims: [
        { text: "It deals 10d6 fire damage.", citations: [ref({ contextId: "C2" })] },
        { text: "Its Armor Class is 18.", citations: [ref()] },
      ],
      rejected: false,
    }, [chunk()], "en");
    assert.equal(result.answer, "Its Armor Class is 18.");
    assert.equal(result.claims.length, 1);
    assert.equal(result.confident, false);
  });

  it("rejects duplicate references and degrades confidence", () => {
    const result = groundGeneratedAnswer({
      claims: [{ text: "Its Armor Class is 18.", citations: [ref(), ref({ quote: "Speed 30 ft." })] }],
      rejected: false,
    }, [chunk()], "en");
    assert.equal(result.claims[0].citations.length, 1);
    assert.equal(result.confident, false);
  });

  it("preserves readable Russian synthesis", () => {
    const ruChunk = chunk({
      quoteText: "Класс Доспеха 18. Скорость 30 футов.", sourceTitle: "Открытые правила",
      sectionHeading: "Страж", language: "ru",
    });
    const result = groundGeneratedAnswer({
      claims: [{ text: "Класс Доспеха стража равен 18.", citations: [ref({
        quote: "Класс Доспеха 18", sourceTitle: "Открытые правила", language: "ru", section: "Страж",
      })] }],
      rejected: false,
    }, [ruChunk], "ru");
    assert.equal(result.answer, "Класс Доспеха стража равен 18.");
    assert.equal(result.confident, true);
  });

  it("supports readable stat-block synthesis with independently linked facts", () => {
    const result = groundGeneratedAnswer({
      claims: [
        { text: "The guardian has AC 18 and 45 hit points.", citations: [ref({ quote: "Armor Class 18. Speed 30 ft. Hit Points 45." })] },
        { text: "Its speed is 30 feet.", citations: [ref({ quote: "Speed 30 ft." })] },
      ], rejected: false,
    }, [chunk()], "en");
    assert.match(result.answer, /AC 18 and 45 hit points/);
    assert.match(result.answer, /speed is 30 feet/);
    assert.equal(result.claims.length, 2);
  });

  it("uses a clear bounded extractive fallback for malformed JSON or zero supported claims", () => {
    const result = groundGeneratedAnswer(parseLlmResponse("not json"), [chunk(), chunk({ chunkId: "2" }), chunk({ chunkId: "3" }), chunk({ chunkId: "4" })], "en");
    assert.match(result.answer, /summary is unavailable/);
    assert.equal(result.claims.length, 0);
    assert.equal(result.citations.length, 3);
    assert.doesNotMatch(result.answer, /Armor Class 18/);
  });

  it("uses the same safe fallback when the provider fails", () => {
    const result = extractiveFallback("en", [chunk()]);
    assert.equal(result.confident, false);
    assert.equal(result.citations[0].quote, chunk().quoteText);
    assert.match(result.answer, /validated source excerpts below/);
  });
});
