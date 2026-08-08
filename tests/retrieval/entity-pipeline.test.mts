import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { buildSourceAccessSql } from "../../src/server/access/access-sql.ts";
import { buildRetrievalAuthorizationFilter } from "../../src/server/access/retrieval-filter.ts";
import { mergeCandidates } from "../../src/server/retrieval/hybrid.ts";
import { hybridSearch } from "../../src/server/retrieval/pipeline.ts";
import { rerankCandidates } from "../../src/server/retrieval/rerank.ts";
import type { EntityResolution } from "../../src/server/retrieval/entity.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function candidate(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "33333333-3333-4333-8333-333333333333",
    sourceId: "44444444-4444-4444-8444-444444444444",
    fileId: "55555555-5555-4555-8555-555555555555",
    text: "Range: Self",
    quoteText: "Range: Self",
    sectionHeading: "Shield",
    pageNumber: 12,
    edition: "5e",
    language: "en",
    sourceTitle: "Open Rules",
    sourceCategory: "core_rules",
    accessTier: "open",
    score: 1,
    strategy: "entity",
    ...overrides,
  };
}

const generationId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const sourceId = "44444444-4444-4444-8444-444444444444";
const versionId = "88888888-8888-4888-8888-888888888888";
const matchedResolution: EntityResolution = {
  matches: [{
    entryId,
    entryType: "spell",
    canonicalKey: "mage-hand",
    title: "Mage Hand",
    aliases: ["Mage's Hand", "Рука мага"],
    edition: "5e",
    language: "en",
    sourceId,
  }],
  candidates: [candidate()],
};

describe("entity retrieval integration contracts", () => {
  it("builds all RBAC and corpus filters used to capture the entity snapshot", () => {
    const filter = buildRetrievalAuthorizationFilter(
      { role: "user" },
      { edition: "5e", language: "ru", category: "core_rules" },
    );
    const { sql, params } = buildSourceAccessSql(filter);

    assert.match(sql, /s\.edition = \$1/);
    assert.match(sql, /s\.language = \$2/);
    assert.match(sql, /s\.category = \$3/);
    assert.match(sql, /s\.access_tier = 'open'/);
    assert.deepEqual(params, ["5e", "ru", "core_rules"]);
  });

  it("resolves entities only after one authorized snapshot and before rewrite", async () => {
    const pipeline = await readFile("src/server/retrieval/pipeline.ts", "utf8");
    const snapshot = pipeline.indexOf("captureRetrievalSnapshot)(accessSql, accessParams)");
    const resolution = pipeline.indexOf("resolveCompendiumEntities)(");
    const rewrite = pipeline.indexOf("rewrite ?? rewriteQuery)(searchQuery)");

    assert.ok(snapshot >= 0);
    assert.ok(resolution > snapshot);
    assert.ok(rewrite > resolution);
    assert.match(pipeline, /resolveCompendiumEntities\)\(\s*searchQuery,\s*snapshot\.generationIds/);
  });

  it("restricts ask-about-entry searches to citation-backed entity chunks", async () => {
    const pipeline = await readFile("src/server/retrieval/pipeline.ts", "utf8");
    const keyword = await readFile("src/server/retrieval/keyword.ts", "utf8");
    const vector = await readFile("src/server/retrieval/vector.ts", "utf8");

    assert.match(pipeline, /entryScope \? \{ chunkIds: entityResolution\.candidates\.map/);
    assert.match(keyword, /if \(chunkIds && chunkIds\.length === 0\) return \[\]/);
    assert.match(keyword, /\$4::uuid\[\] IS NULL OR c\.id = ANY\(\$4::uuid\[\]\)/);
    assert.match(vector, /if \(chunkIds && chunkIds\.length === 0\) return \[\]/);
    assert.match(vector, /\$4::uuid\[\] IS NULL OR c\.id = ANY\(\$4::uuid\[\]\)/);
  });

  it("keeps general search unrestricted when no entry scope is supplied", async () => {
    const pipeline = await readFile("src/server/retrieval/pipeline.ts", "utf8");

    assert.match(pipeline, /\.\.\.\(entryScope \? \{ chunkIds:/);
    assert.match(pipeline, /: \{\}\),/);
    assert.match(pipeline, /\[entityResolution\.candidates, keywordResults, vectorResults\]/);
  });

  it("injects exact entity chunks without replacing chunk provenance", () => {
    const entity = candidate({
      entityEvidence: [{
        entryId: "22222222-2222-4222-8222-222222222222",
        entryType: "spell",
        canonicalKey: "shield",
        title: "Shield",
        citationId: "66666666-6666-4666-8666-666666666666",
        citationKind: "field",
        fieldPath: "$.range",
        quote: "Range: Self",
      }],
    });
    const semantic = candidate({
      chunkId: "77777777-7777-4777-8777-777777777777",
      strategy: "vector",
      entityEvidence: undefined,
    });

    const result = rerankCandidates(
      mergeCandidates([[entity], [], [semantic]], { limit: 10 }),
      "Shield range",
    );

    assert.deepEqual(new Set(result.map((chunk) => chunk.chunkId)), new Set([
      entity.chunkId,
      semantic.chunkId,
    ]));
    const enriched = result.find((chunk) => chunk.chunkId === entity.chunkId);
    assert.equal(enriched?.quoteText, "Range: Self");
    assert.equal(enriched?.sourceId, entity.sourceId);
    assert.equal(enriched?.entityEvidence?.[0].fieldPath, "$.range");
  });

  it("executes authorized entity resolution before rewrite for RU and EN aliases", async () => {
    for (const query of ["How does Mage's Hand work?", "Как работает Рука мага?"]) {
      const events: string[] = [];
      const result = await hybridSearch(
        { query, user: { role: "user" }, rewriteEnabled: true },
        {
          captureSnapshot: async () => {
            events.push("snapshot");
            return { generationIds: [generationId] };
          },
          resolveEntities: async (searchQuery) => {
            events.push("entity");
            assert.equal(searchQuery, query);
            return matchedResolution;
          },
          rewrite: async () => {
            events.push("rewrite");
            return { original: query, canonical: "mage hand", bilingual: [], expanded: [] };
          },
          keyword: async () => [],
          vector: async () => [],
        },
      );

      assert.deepEqual(events.slice(0, 3), ["snapshot", "entity", "rewrite"]);
      assert.equal(result.chunks[0].strategy, "entity");
      assert.ok(result.rewrite?.expanded.includes("Mage's Hand"));
      assert.ok(result.rewrite?.expanded.includes("Рука мага"));
    }
  });

  it("makes inaccessible and nonexistent entry scopes indistinguishable", async () => {
    async function scopedSearch(scopedEntryId: string) {
      return hybridSearch(
        {
          query: "What is its range?",
          user: { role: "user" },
          entryScope: { entryId: scopedEntryId, sourceId, versionId, edition: "5e", language: "en" },
          rewriteEnabled: false,
        },
        {
          captureSnapshot: async () => ({ generationIds: [generationId] }),
          resolveEntities: async () => ({ matches: [], candidates: [] }),
          keyword: async (_query, params) => {
            assert.deepEqual(params.chunkIds, []);
            return [];
          },
          vector: async (_query, params) => {
            assert.deepEqual(params.chunkIds, []);
            return [];
          },
        },
      );
    }

    const inaccessible = await scopedSearch(entryId);
    const nonexistent = await scopedSearch("99999999-9999-4999-8999-999999999999");
    assert.deepEqual(nonexistent, inaccessible);
  });

  it("does not resolve or semantically search a conflicting selection and scope", async () => {
    let resolverCalled = false;
    const result = await hybridSearch(
      {
        query: "What is its range?",
        user: { role: "user" },
        selection: { edition: "5.5e", language: "ru" },
        entryScope: { entryId, sourceId, versionId, edition: "5e", language: "en" },
        rewriteEnabled: false,
      },
      {
        captureSnapshot: async () => ({ generationIds: [generationId] }),
        resolveEntities: async () => {
          resolverCalled = true;
          return matchedResolution;
        },
        keyword: async (_query, params) => {
          assert.deepEqual(params.chunkIds, []);
          return [];
        },
        vector: async (_query, params) => {
          assert.deepEqual(params.chunkIds, []);
          return [];
        },
      },
    );

    assert.equal(resolverCalled, false);
    assert.deepEqual(result.chunks, []);
  });

  it("executes the unchanged general hybrid path without entry chunk filters", async () => {
    const keywordCandidate = candidate({ chunkId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", strategy: "keyword" });
    const vectorCandidate = candidate({ chunkId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", strategy: "vector" });
    const result = await hybridSearch(
      { query: "general combat rules", user: { role: "user" }, rewriteEnabled: false },
      {
        captureSnapshot: async () => ({ generationIds: [generationId] }),
        resolveEntities: async () => ({ matches: [], candidates: [] }),
        keyword: async (_query, params) => {
          assert.equal(params.chunkIds, undefined);
          return [keywordCandidate];
        },
        vector: async (_query, params) => {
          assert.equal(params.chunkIds, undefined);
          return [vectorCandidate];
        },
      },
    );

    assert.deepEqual(new Set(result.chunks.map((chunk) => chunk.chunkId)), new Set([
      keywordCandidate.chunkId,
      vectorCandidate.chunkId,
    ]));
    assert.deepEqual(result.entityMatches, []);
  });
});
