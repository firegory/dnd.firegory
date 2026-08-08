import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { buildSourceAccessSql } from "../../src/server/access/access-sql.ts";
import { buildRetrievalAuthorizationFilter } from "../../src/server/access/retrieval-filter.ts";
import { mergeCandidates } from "../../src/server/retrieval/hybrid.ts";
import { rerankCandidates } from "../../src/server/retrieval/rerank.ts";
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
});
