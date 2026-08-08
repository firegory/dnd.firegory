import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { groundGeneratedAnswer } from "../../src/server/rag/ground.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1",
    sourceId: "source-1",
    fileId: "file-1",
    text: "Range: Self. Duration: 1 round.",
    quoteText: "Range: Self. Duration: 1 round.",
    sectionHeading: "Shield",
    pageNumber: 12,
    edition: "5e",
    language: "en",
    sourceTitle: "Open Rules",
    sourceCategory: "core_rules",
    accessTier: "open",
    score: 1,
    strategy: "entity",
    entityEvidence: [{
      entryId: "entry-1",
      entryType: "spell",
      canonicalKey: "shield",
      title: "Shield",
      citationId: "citation-1",
      citationKind: "field",
      fieldPath: "$.range",
      quote: "Range: Self",
    }],
    ...overrides,
  };
}

describe("groundGeneratedAnswer", () => {
  it("never returns generated prose or confidence without a validated citation", () => {
    const result = groundGeneratedAnswer(
      { answer: "Shield deals 4d6 damage.", confident: true, citations: [{ quote: "Damage: 4d6" }] },
      [chunk()],
      "en",
    );

    assert.equal(result.confident, false);
    assert.deepEqual(result.citations, []);
    assert.doesNotMatch(result.answer, /4d6/);
    assert.equal(result.retrievedChunks, 1);
  });

  it("degrades a partially cited response to validated source excerpts", () => {
    const result = groundGeneratedAnswer(
      {
        answer: "Self range and 4d6 damage.",
        confident: true,
        citations: [{ quote: "Range: Self" }, { quote: "Damage: 4d6" }],
      },
      [chunk()],
      "en",
    );

    assert.equal(result.confident, false);
    assert.equal(result.citations.length, 1);
    assert.match(result.answer, /Range: Self/);
    assert.doesNotMatch(result.answer, /4d6/);
  });

  it("keeps a fully cited general answer and uses authoritative locations", () => {
    const result = groundGeneratedAnswer(
      { answer: "The spell has a range of Self.", confident: true, citations: [{ quote: "Range: Self", page: 99, section: "Wrong" }] },
      [chunk()],
      "en",
    );

    assert.equal(result.answer, "The spell has a range of Self.");
    assert.equal(result.confident, true);
    assert.equal(result.citations[0].page, 12);
    assert.equal(result.citations[0].section, "Shield");
    assert.equal(result.citations[0].entityEvidence?.[0].fieldPath, "$.range");
  });

  it("makes scoped entity answers extractive even when all citations validate", () => {
    const result = groundGeneratedAnswer(
      { answer: "Unverifiable structured summary", confident: true, citations: [{ quote: "Range: Self" }] },
      [chunk()],
      "en",
      true,
    );

    assert.equal(result.confident, false);
    assert.doesNotMatch(result.answer, /structured summary/);
    assert.match(result.answer, /Range: Self/);
    assert.equal(result.citations[0].entityEvidence?.[0].fieldPath, "$.range");
    assert.deepEqual(Object.keys(result.citations[0].entityEvidence?.[0] ?? {}).sort(), [
      "citationId",
      "citationKind",
      "entryId",
      "fieldPath",
    ]);
  });

  it("carries field evidence end-to-end from parsed JSON without exposing model structured content", async () => {
    const { parseLlmResponse } = await import("../../src/server/rag/format.ts");
    const parsed = parseLlmResponse(JSON.stringify({
      answer: "Model summary",
      confident: true,
      entity: { range: "Self", damage: "4d6" },
      citations: [{ quote: "Range: Self", sourceTitle: "Open Rules" }],
    }));
    const result = groundGeneratedAnswer(parsed, [chunk()], "en", true);

    assert.doesNotMatch(result.answer, /Model summary|4d6/);
    assert.equal(result.citations[0].quote, "Range: Self");
    assert.equal(result.citations[0].entityEvidence?.[0].citationId, "citation-1");
    assert.equal(result.citations[0].page, 12);
    assert.equal(result.citations[0].section, "Shield");
  });
});
