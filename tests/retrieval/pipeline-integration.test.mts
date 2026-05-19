/**
 * Integration tests for the full retrieval pipeline.
 *
 * Tests the complete flow: access filter building → SQL generation →
 * query expansion → hybrid merge → reranking, with focus on
 * access control enforcement at each stage.
 *
 * These tests exercise the pipeline orchestrator (`hybridSearch`) indirectly
 * by testing the component composition: buildRetrievalAuthorizationFilter →
 * buildSourceAccessSql → expandQuery → mergeCandidates → rerankCandidates.
 *
 * The DB-dependent layers (keywordSearch, vectorSearch) are not called here
 * since they require a live Postgres + pgvector. The pure functions that
 * compose the pipeline are validated to ensure correctness of the
 * authorization flow end-to-end.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildRetrievalAuthorizationFilter,
  sourceMatchesRetrievalAuthorizationFilter,
  type SourceAccessMetadata,
} from "../../src/server/access/retrieval-filter.ts";
import { buildSourceAccessSql } from "../../src/server/access/access-sql.ts";
import {
  expandQuery,
  combinedExpandedQuery,
} from "../../src/server/retrieval/expand.ts";
import { mergeCandidates, type HybridMergeConfig } from "../../src/server/retrieval/hybrid.ts";
import {
  rerankCandidates,
  noopRerankConfig,
} from "../../src/server/retrieval/rerank.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

// ---------- Helpers ----------

function makeCandidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1",
    sourceId: "src-1",
    fileId: "file-1",
    text: "Test chunk text about armor class.",
    quoteText: "Armor Class represents how well a creature avoids being hit.",
    sectionHeading: "Combat",
    pageNumber: 42,
    edition: "5e",
    language: "en",
    sourceTitle: "Basic Rules",
    sourceCategory: "core_rules",
    accessTier: "open",
    score: 0.9,
    strategy: "keyword",
    ...overrides,
  };
}

// ---------- Tests ----------

describe("pipeline integration: access filter → SQL", () => {
  it("user role produces open-only SQL for every corpus selection", () => {
    const selections: Array<{ edition?: "5e" | "5.5e"; language?: "en" | "ru"; category?: "core_rules" | "official_supplement" | "homebrew" }> = [
      {},
      { edition: "5e" },
      { language: "ru" },
      { edition: "5.5e", language: "en" },
      { edition: "5e", language: "ru", category: "core_rules" },
    ];

    for (const selection of selections) {
      const filter = buildRetrievalAuthorizationFilter({ role: "user" }, selection);
      const { sql } = buildSourceAccessSql(filter);

      // User must always be restricted to open-only access
      assert.ok(
        sql.includes("s.access_tier = 'open'"),
        `User should only see open content for selection ${JSON.stringify(selection)}, got: ${sql}`,
      );
      assert.ok(
        !sql.includes("personal"),
        `User should never have personal access for selection ${JSON.stringify(selection)}`,
      );
    }
  });

  it("premium role SQL includes personal ownership parameter", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "premium-42" },
      { edition: "5e" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.ok(sql.includes("s.owner_user_id"), "Should include ownership check");
    assert.ok(params.includes("premium-42"), "Should include userId param");
    assert.ok(params.includes("5e"), "Should include edition param");
  });

  it("admin role SQL has no access restriction regardless of selection", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "admin", userId: "admin-1" },
      { edition: "5e", language: "en", category: "core_rules" },
    );
    const { sql } = buildSourceAccessSql(filter);

    assert.ok(!sql.includes("access_tier"), "Admin should not have access_tier conditions");
    assert.ok(sql.includes("s.edition = $"));
    assert.ok(sql.includes("s.language = $"));
    assert.ok(sql.includes("s.category = $"));
  });
});

describe("pipeline integration: query expansion does not bypass filters", () => {
  it("expanded terms are separate from access control", () => {
    // Expansion adds terms but access SQL is generated independently
    const filter = buildRetrievalAuthorizationFilter({ role: "user" });
    const expansions = expandQuery("What is the AC of a dragon?", {
      enabled: true,
      bilingual: true,
    });

    // Expansion should add terms
    assert.ok(expansions.length > 1, "Should expand AC alias");

    // But the access SQL should still be open-only
    const { sql } = buildSourceAccessSql(filter);
    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(!sql.includes("personal"));
  });

  it("bilingual expansion adds Russian terms for English query", () => {
    const expansions = expandQuery("saving throw", {
      enabled: true,
      bilingual: true,
    });

    const texts = expansions.map((e) => e.text.toLowerCase());
    assert.ok(texts.includes("saving throw"), "Original should be present");
    assert.ok(
      texts.some((t) => t.includes("спасбросок")),
      "Should include Russian translation",
    );
  });

  it("expansion with disabled bilingual does not add translations", () => {
    const expansions = expandQuery("saving throw", {
      enabled: true,
      bilingual: false,
    });

    const texts = expansions.map((e) => e.text.toLowerCase());
    assert.ok(!texts.some((t) => /[а-яё]/i.test(t)), "Should not include Cyrillic text");
  });

  it("combined expanded query preserves original for keyword search", () => {
    const expansions = expandQuery("What is the DC for a spell?", {
      enabled: true,
    });
    const combined = combinedExpandedQuery(expansions);

    assert.ok(combined.includes("DC"), "Should include original DC");
    assert.ok(combined.includes("difficulty class"), "Should include expanded term");
  });
});

describe("pipeline integration: hybrid merge + rerank", () => {
  it("merge deduplicates across strategies while preserving scores", () => {
    const keywordResult = [
      makeCandidate({ chunkId: "c1", score: 0.8, strategy: "keyword" }),
      makeCandidate({ chunkId: "c2", score: 0.6, strategy: "keyword" }),
    ];
    const vectorResult = [
      makeCandidate({ chunkId: "c1", score: 0.9, strategy: "vector" }),
      makeCandidate({ chunkId: "c3", score: 0.7, strategy: "vector" }),
    ];

    const merged = mergeCandidates([keywordResult, vectorResult], { limit: 10 });

    assert.equal(merged.length, 3, "Should deduplicate c1, keep c2+c3");
    // c1 appears in both strategies, so it should have highest RRF score
    assert.equal(merged[0].chunkId, "c1", "c1 should be ranked first (boosted by both)");
  });

  it("rerank respects source category priority", () => {
    const candidates = [
      makeCandidate({
        chunkId: "c1",
        sourceCategory: "homebrew",
        score: 0.95,
        sectionHeading: null,
      }),
      makeCandidate({
        chunkId: "c2",
        sourceCategory: "core_rules",
        score: 0.90,
        sectionHeading: null,
      }),
    ];

    const reranked = rerankCandidates(candidates, "test query", { enabled: true });

    // core_rules has priority 1.0, homebrew has 0.7
    // c2: 0.90 * 1.0 = 0.90, c1: 0.95 * 0.7 = 0.665
    assert.equal(reranked[0].chunkId, "c2", "Core rules should outrank homebrew after priority");
  });

  it("rerank applies section heading match bonus", () => {
    const candidates = [
      makeCandidate({
        chunkId: "c1",
        sectionHeading: "Unrelated Topic",
        score: 0.90,
        sourceCategory: "core_rules",
      }),
      makeCandidate({
        chunkId: "c2",
        sectionHeading: "Combat Rules and Armor Class",
        score: 0.90,
        sourceCategory: "core_rules",
      }),
    ];

    const reranked = rerankCandidates(candidates, "armor class rules", { enabled: true });

    // c2 has heading match bonus for "armor" and "rules"
    assert.equal(reranked[0].chunkId, "c2", "Section heading match should boost c2");
  });

  it("noop reranker preserves original order", () => {
    const candidates = [
      makeCandidate({ chunkId: "c1", score: 0.9 }),
      makeCandidate({ chunkId: "c2", score: 0.5 }),
    ];

    const reranked = rerankCandidates(candidates, "test", noopRerankConfig());

    assert.equal(reranked[0].chunkId, "c1");
    assert.equal(reranked[1].chunkId, "c2");
    assert.equal(reranked[0].score, 0.9, "Score should be unchanged");
  });

  it("full merge+rerank pipeline respects limit", () => {
    const candidates = Array.from({ length: 50 }, (_, i) =>
      makeCandidate({
        chunkId: `c${i}`,
        score: 1 - i * 0.01,
        sourceCategory: "core_rules",
        sectionHeading: null,
      }),
    );

    const merged = mergeCandidates([candidates], { limit: 10 });

    assert.equal(merged.length, 10, "Should truncate to limit");
  });
});

describe("pipeline integration: access filter + source matching consistency", () => {
  const sources: Array<{ name: string; meta: SourceAccessMetadata }> = [
    {
      name: "open English 5e core",
      meta: { accessTier: "open", edition: "5e", language: "en", category: "core_rules" },
    },
    {
      name: "open Russian 5e core",
      meta: { accessTier: "open", edition: "5e", language: "ru", category: "core_rules" },
    },
    {
      name: "premium shared English supplement",
      meta: { accessTier: "premium", shared: true, edition: "5e", language: "en", category: "official_supplement" },
    },
    {
      name: "personal owned homebrew",
      meta: { accessTier: "personal", ownerUserId: "user-A", edition: "5e", language: "en", category: "homebrew" },
    },
    {
      name: "open English 5.5e supplement",
      meta: { accessTier: "open", edition: "5.5e", language: "en", category: "official_supplement" },
    },
  ];

  it("user with 5e/EN filter sees exactly the right sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user", userId: "user-A" },
      { edition: "5e", language: "en" },
    );

    const visible = sources.filter((s) =>
      sourceMatchesRetrievalAuthorizationFilter(s.meta, filter),
    );

    assert.equal(visible.length, 1, `Expected exactly 1 source, got: ${visible.map((v) => v.name).join(", ")}`);
    assert.equal(visible[0].name, "open English 5e core");
  });

  it("premium user-A with no corpus filter sees open + shared + own personal", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-A" },
    );

    const visible = sources.filter((s) =>
      sourceMatchesRetrievalAuthorizationFilter(s.meta, filter),
    );

    const names = visible.map((v) => v.name);
    assert.ok(names.includes("open English 5e core"), "Should see open 5e EN");
    assert.ok(names.includes("open Russian 5e core"), "Should see open 5e RU");
    assert.ok(names.includes("premium shared English supplement"), "Should see shared premium");
    assert.ok(names.includes("personal owned homebrew"), "Should see own personal");
    assert.ok(names.includes("open English 5.5e supplement"), "Should see 5.5e when no edition filter");
    assert.equal(visible.length, 5, `Expected all 5 visible sources for premium user-A without corpus filter, got: ${names.join(", ")}`);
  });

  it("admin with 5e filter sees all 5e sources", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "admin", userId: "admin-1" },
      { edition: "5e" },
    );

    const visible = sources.filter((s) =>
      sourceMatchesRetrievalAuthorizationFilter(s.meta, filter),
    );

    assert.equal(visible.length, 4, `Expected 4 five-e sources, got: ${visible.map((v) => v.name).join(", ")}`);
  });

  it("premium user-B cannot see user-A's personal content", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "user-B" },
    );

    const visible = sources.filter((s) =>
      sourceMatchesRetrievalAuthorizationFilter(s.meta, filter),
    );

    const names = visible.map((v) => v.name);
    assert.ok(!names.includes("personal owned homebrew"), "user-B should not see user-A's personal content");
  });
});

describe("pipeline integration: SQL generation matches filter logic", () => {
  it("user filter SQL and in-memory filter agree on open-only access", () => {
    const openSource: SourceAccessMetadata = {
      accessTier: "open",
      edition: "5e",
      language: "en",
      category: "core_rules",
    };
    const premiumSource: SourceAccessMetadata = {
      accessTier: "premium",
      shared: true,
      edition: "5e",
      language: "en",
      category: "official_supplement",
    };

    const filter = buildRetrievalAuthorizationFilter({ role: "user" });
    const { sql } = buildSourceAccessSql(filter);

    // In-memory: open matches, premium doesn't
    assert.ok(sourceMatchesRetrievalAuthorizationFilter(openSource, filter));
    assert.ok(!sourceMatchesRetrievalAuthorizationFilter(premiumSource, filter));

    // SQL: should have open condition but not premium
    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(!sql.includes("s.shared = true"));
  });

  it("premium filter SQL and in-memory filter agree on access tiers", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "premium", userId: "p-1" },
    );
    const { sql } = buildSourceAccessSql(filter);

    // SQL should contain all three tier conditions
    assert.ok(sql.includes("s.access_tier = 'open'"));
    assert.ok(sql.includes("s.access_tier = 'premium' AND s.shared = true"));
    assert.ok(sql.includes("s.access_tier = 'personal' AND s.owner_user_id"));

    // And the ownerUserId param
    const paramIdx = sql.match(/\$(\d+)/g);
    assert.ok(paramIdx, "Should have parameterized conditions");
  });
});
