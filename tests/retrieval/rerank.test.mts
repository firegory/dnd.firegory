import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  rerankCandidates,
  noopRerankConfig,
} from "../../src/server/retrieval/rerank.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

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

describe("rerankCandidates", () => {
  it("returns empty array for empty input", () => {
    const result = rerankCandidates([], "query");
    assert.deepStrictEqual(result, []);
  });

  it("passes through candidates when disabled", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.1 }),
      makeCandidate({ chunkId: "b", score: 0.9 }),
    ];

    const result = rerankCandidates(candidates, "query", { enabled: false });
    // Should return in original order when disabled
    assert.strictEqual(result[0].chunkId, "a");
    assert.strictEqual(result[1].chunkId, "b");
  });

  it("preserves original scores when no adjustments apply", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.8, sourceCategory: "core_rules" }),
    ];

    const result = rerankCandidates(candidates, "unrelated query");
    assert.strictEqual(result[0].score, 0.8); // core_rules priority is 1.0, no heading match
  });

  it("applies source category priority", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5, sourceCategory: "homebrew" }),
      makeCandidate({ chunkId: "b", score: 0.5, sourceCategory: "core_rules" }),
      makeCandidate({ chunkId: "c", score: 0.5, sourceCategory: "official_supplement" }),
    ];

    const result = rerankCandidates(candidates, "query");
    // Same base score, but core_rules (1.0) > official_supplement (0.9) > homebrew (0.7)
    assert.strictEqual(result[0].chunkId, "b");
    assert.strictEqual(result[1].chunkId, "c");
    assert.strictEqual(result[2].chunkId, "a");
  });

  it("applies section heading match bonus", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5, sectionHeading: "Combat Rules" }),
      makeCandidate({ chunkId: "b", score: 0.5, sectionHeading: "Magic Items" }),
    ];

    const result = rerankCandidates(candidates, "combat");
    // 'a' has matching section heading, should rank higher
    assert.strictEqual(result[0].chunkId, "a");
    assert.ok(result[0].score > result[1].score);
  });

  it("ignores short query terms for heading match", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5, sectionHeading: "The Map" }),
      makeCandidate({ chunkId: "b", score: 0.5, sectionHeading: "Combat" }),
    ];

    // "a" — 1-letter term "a" is too short (< 3 chars)
    const result = rerankCandidates(candidates, "a map");
    // Both get same heading bonus or neither, since "map" matches "Map" for both
    // Actually: "map" (3 chars, included) matches "Map" in "The Map"
    assert.strictEqual(result[0].chunkId, "a");
  });

  it("respects custom source priority", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5, sourceCategory: "core_rules" }),
      makeCandidate({ chunkId: "b", score: 0.5, sourceCategory: "homebrew" }),
    ];

    const result = rerankCandidates(candidates, "query", {
      sourcePriority: { homebrew: 2.0, core_rules: 0.5 },
    });
    // Homebrew now has higher priority
    assert.strictEqual(result[0].chunkId, "b");
  });

  it("handles null section headings without error", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5, sectionHeading: null }),
    ];

    const result = rerankCandidates(candidates, "combat");
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].chunkId, "a");
  });

  it("does not modify original array", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.5 }),
    ];

    const result = rerankCandidates(candidates, "query");
    // Original score should be unchanged
    assert.strictEqual(candidates[0].score, 0.5);
    // Result may have adjusted score
    assert.ok(typeof result[0].score === "number");
  });
});

describe("noopRerankConfig", () => {
  it("returns disabled config", () => {
    const config = noopRerankConfig();
    assert.strictEqual(config.enabled, false);
  });
});
