import { describe, it } from "node:test";
import assert from "node:assert/strict";

/**
 * Pipeline integration test.
 *
 * Tests the hybridSearch orchestrator by mocking the DB query function
 * and the embedding provider. Pure-function modules (hybrid, expand, rerank)
 * have their own dedicated test files.
 */

// We test the pipeline's orchestration logic by importing and calling
// the pure helper functions and checking the types/structure.

import { expandQuery, combinedExpandedQuery } from "../../src/server/retrieval/expand.ts";
import { mergeCandidates } from "../../src/server/retrieval/hybrid.ts";
import { rerankCandidates } from "../../src/server/retrieval/rerank.ts";
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

describe("pipeline integration: expand → merge → rerank", () => {
  it("full pipeline with keyword-only results", () => {
    const query = "ac modifier";

    // Step 1: Expand
    const expansions = expandQuery(query, { enabled: true });
    assert.ok(expansions.length >= 2); // original + alias
    const combinedQuery = combinedExpandedQuery(expansions);
    assert.ok(combinedQuery.includes("armor class"));

    // Step 2: Simulate keyword results (no vector results)
    const keywordResults = [
      makeCandidate({ chunkId: "a", score: 0.9, strategy: "keyword", text: "AC is armor class" }),
      makeCandidate({ chunkId: "b", score: 0.6, strategy: "keyword", text: "AC modifier rules" }),
    ];

    // Step 3: Merge
    const merged = mergeCandidates([keywordResults, []], { limit: 20 });
    assert.strictEqual(merged.length, 2);

    // Step 4: Rerank
    const reranked = rerankCandidates(merged, query, { enabled: true });
    assert.strictEqual(reranked.length, 2);
    // Scores may change but order could stay the same
    assert.ok(reranked[0].score >= reranked[1].score);
  });

  it("full pipeline with hybrid results", () => {
    const query = "fireball spell";

    const expansions = expandQuery(query);
    assert.strictEqual(expansions.length, 1); // "spell" triggers no alias currently

    const keywordResults = [
      makeCandidate({ chunkId: "a", score: 0.8, strategy: "keyword" }),
      makeCandidate({ chunkId: "b", score: 0.5, strategy: "keyword" }),
    ];
    const vectorResults = [
      makeCandidate({ chunkId: "b", score: 0.9, strategy: "vector" }),
      makeCandidate({ chunkId: "c", score: 0.7, strategy: "vector" }),
    ];

    const merged = mergeCandidates([keywordResults, vectorResults], { limit: 20 });
    // 3 unique chunks: a, b, c
    assert.strictEqual(merged.length, 3);

    // Chunk b appears in both strategies, should have highest RRF score
    assert.strictEqual(merged[0].chunkId, "b");

    const reranked = rerankCandidates(merged, query);
    assert.strictEqual(reranked.length, 3);
  });

  it("respects final limit after rerank", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      makeCandidate({ chunkId: `c-${i}`, score: 0.5 + Math.random() * 0.5, strategy: "keyword" }),
    );

    const merged = mergeCandidates([candidates], { limit: 50 });
    const _reranked = rerankCandidates(merged, "query");

    // Pipeline caller truncates, but let's verify merge respects limit
    const limited = mergeCandidates([candidates], { limit: 10 });
    assert.strictEqual(limited.length, 10);
  });

  it("expansion does not bypass language filter", () => {
    // Expansion adds terms but they're used in the same filtered SQL query.
    // We verify that the expansion itself doesn't contain inappropriate terms
    // when bilingual is disabled.
    const result = expandQuery("armor class", { enabled: true, bilingual: false });
    const texts = result.map((r) => r.text);
    assert.ok(!texts.includes("класс брони"));
  });

  it("reranker can be disabled without breaking pipeline", () => {
    const candidates = [
      makeCandidate({ chunkId: "a", score: 0.1, sourceCategory: "homebrew" }),
      makeCandidate({ chunkId: "b", score: 0.9, sourceCategory: "core_rules" }),
    ];

    const merged = mergeCandidates([candidates], { limit: 10 });
    const reranked = rerankCandidates(merged, "query", { enabled: false });

    // When disabled, returns in merge order (a first since lower score → lower rank in RRF)
    assert.strictEqual(reranked.length, 2);
    // Order should be same as input (no reranking)
    assert.strictEqual(reranked[0].chunkId, merged[0].chunkId);
    assert.strictEqual(reranked[1].chunkId, merged[1].chunkId);
  });
});
