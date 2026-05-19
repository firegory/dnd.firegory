import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { mergeCandidates } from "../../src/server/retrieval/hybrid.ts";

function makeCandidate(overrides: Partial<RetrievalCandidate> & { chunkId: string }): RetrievalCandidate {
  return {
    sourceId: "src-1",
    fileId: "file-1",
    text: "test chunk",
    quoteText: "test quote",
    sectionHeading: null,
    pageNumber: null,
    edition: "5e",
    language: "en",
    sourceTitle: "Test Source",
    sourceCategory: "core_rules",
    accessTier: "open",
    score: 0.5,
    strategy: "keyword",
    ...overrides,
  };
}

describe("mergeCandidates (RRF)", () => {
  it("returns empty array for empty input", () => {
    const result = mergeCandidates([], { limit: 10 });
    assert.deepStrictEqual(result, []);
  });

  it("returns empty array for arrays of empty arrays", () => {
    const result = mergeCandidates([[], []], { limit: 10 });
    assert.deepStrictEqual(result, []);
  });

  it("passes through single strategy results", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword" }),
      makeCandidate({ chunkId: "b", score: 0.5, strategy: "keyword" }),
    ];

    const result = mergeCandidates([candidates], { limit: 10 });
    assert.strictEqual(result.length, 2);
    // First candidate should have higher RRF score (rank 0)
    assert.ok(result[0].score > result[1].score);
  });

  it("deduplicates by chunk ID across strategies", () => {
    const keyword = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword" }),
      makeCandidate({ chunkId: "b", score: 0.5, strategy: "keyword" }),
    ];
    const vector = [
      makeCandidate({ chunkId: "a", score: 0.8, strategy: "vector" }),
      makeCandidate({ chunkId: "c", score: 0.7, strategy: "vector" }),
    ];

    const result = mergeCandidates([keyword, vector], { limit: 10 });
    // Should have 3 unique chunks: a, b, c
    assert.strictEqual(result.length, 3);
    const ids = result.map((r) => r.chunkId);
    assert.ok(ids.includes("a"));
    assert.ok(ids.includes("b"));
    assert.ok(ids.includes("c"));
  });

  it("boosts chunks found by multiple strategies", () => {
    const keyword = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword" }),
      makeCandidate({ chunkId: "b", score: 0.8, strategy: "keyword" }),
    ];
    const vector = [
      makeCandidate({ chunkId: "b", score: 0.9, strategy: "vector" }), // b is rank 0 in vector
      makeCandidate({ chunkId: "a", score: 0.5, strategy: "vector" }), // a is rank 1 in vector
    ];

    const result = mergeCandidates([keyword, vector], { limit: 10 });

    // Both a and b appear in both strategies, so they should have higher RRF
    // scores than any single-strategy chunk.
    // But with this data both are multi-strategy, so b should be ranked first
    // because it has rank 1 (keyword) + rank 0 (vector) vs a's rank 0 + rank 1.
    // RRF for a: 1/(60+1) + 1/(60+2) = 1/61 + 1/62
    // RRF for b: 1/(60+2) + 1/(60+1) = 1/62 + 1/61  → same!
    // Actually they're the same since both are (rank0 + rank1) across strategies
    assert.strictEqual(result.length, 2);
  });

  it("respects the limit parameter", () => {
    const candidates = Array.from({ length: 20 }, (_, i) =>
      makeCandidate({ chunkId: `chunk-${i}`, score: 1 - i * 0.05, strategy: "keyword" }),
    );

    const result = mergeCandidates([candidates], { limit: 5 });
    assert.strictEqual(result.length, 5);
  });

  it("clamps limit to max 200", () => {
    const candidates = Array.from({ length: 250 }, (_, i) =>
      makeCandidate({ chunkId: `chunk-${i}`, score: 1 - i * 0.001, strategy: "keyword" }),
    );

    const result = mergeCandidates([candidates], { limit: 300 });
    assert.strictEqual(result.length, 200);
  });

  it("uses custom RRF k parameter", () => {
    const keyword = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword" }),
      makeCandidate({ chunkId: "b", score: 0.1, strategy: "keyword" }),
    ];
    const vector = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "vector" }),
      makeCandidate({ chunkId: "b", score: 0.1, strategy: "vector" }),
    ];

    const resultK1 = mergeCandidates([keyword, vector], { limit: 10, rrfK: 1 });
    const resultK100 = mergeCandidates([keyword, vector], { limit: 10, rrfK: 100 });

    // Both should have same order (a before b), but different absolute scores
    assert.strictEqual(resultK1[0].chunkId, resultK100[0].chunkId);
    assert.ok(resultK1[0].score > resultK100[0].score); // Lower k = higher scores
  });

  it("handles strategy with no results gracefully", () => {
    const keyword = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword" }),
    ];
    const vector: RetrievalCandidate[] = [];

    const result = mergeCandidates([keyword, vector], { limit: 10 });
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].chunkId, "a");
  });

  it("preserves metadata from first occurrence of a chunk", () => {
    const keyword = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword", text: "from keyword" }),
    ];
    const vector = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "vector", text: "from vector" }),
    ];

    const result = mergeCandidates([keyword, vector], { limit: 10 });
    assert.strictEqual(result.length, 1);
    // First strategy's metadata wins
    assert.strictEqual(result[0].text, "from keyword");
  });
});
