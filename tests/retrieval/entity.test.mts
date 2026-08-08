import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  enrichRewriteWithEntities,
  entryScopeConflictsWithSelection,
  isCompendiumEntryScope,
  resolveCompendiumEntities,
} from "../../src/server/retrieval/entity.ts";

const generationId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";
const sourceId = "33333333-3333-4333-8333-333333333333";
const versionId = "88888888-8888-4888-8888-888888888888";

function entityRow(overrides: Record<string, unknown> = {}) {
  return {
    entry_id: entryId,
    entry_type: "spell",
    canonical_key: "shield",
    title: "Shield",
    aliases: ["Щит"],
    edition: "5e",
    language: "en",
    source_id: sourceId,
    file_id: "44444444-4444-4444-8444-444444444444",
    source_title: "Open Rules",
    source_category: "core_rules",
    access_tier: "open",
    chunk_id: "55555555-5555-4555-8555-555555555555",
    text: "Shield has a range of Self.",
    quote_text: "Range: Self",
    section_heading: "Shield",
    page_number: 12,
    citation_id: "66666666-6666-4666-8666-666666666666",
    citation_kind: "field",
    field_path: "$.range",
    citation_quote: "Range: Self",
    ...overrides,
  };
}

describe("resolveCompendiumEntities", () => {
  it("resolves exact English titles and Russian aliases from authorized generations", async () => {
    for (const searchQuery of ["How does Shield work?", "Как работает Щит?"]) {
      let sql = "";
      let params: readonly unknown[] = [];
      const resolution = await resolveCompendiumEntities(
        searchQuery,
        [generationId],
        undefined,
        (async (statement: string, values: readonly unknown[]) => {
          sql = statement;
          params = values;
          return { rows: [entityRow()] } as never;
        }) as never,
      );

      assert.match(sql, /compendium_normalize_name/);
      assert.match(sql, /compendium_names exact_name/);
      assert.match(sql, /citation\.generation_id = ANY\(\$1::uuid\[\]\)/);
      assert.deepEqual(params, [[generationId], searchQuery]);
      assert.equal(resolution.matches[0].title, "Shield");
      assert.deepEqual(resolution.matches[0].aliases, ["Щит"]);
      assert.equal(resolution.candidates[0].strategy, "entity");
      assert.equal(resolution.candidates[0].quoteText, "Range: Self");
      assert.equal(resolution.candidates[0].entityEvidence?.[0].fieldPath, "$.range");
    }
  });

  it("returns no context without authorized generations", async () => {
    let queried = false;
    const result = await resolveCompendiumEntities(
      "Shield",
      [],
      undefined,
      (async () => {
        queried = true;
        return { rows: [entityRow()] } as never;
      }) as never,
    );

    assert.deepEqual(result, { matches: [], candidates: [] });
    assert.equal(queried, false);
  });

  it("binds ask-about-entry source and edition scope without changing authorization", async () => {
    let sql = "";
    let params: readonly unknown[] = [];
    await resolveCompendiumEntities(
      "What is its range?",
      [generationId],
      { entryId, sourceId, edition: "5e", language: "ru" },
      (async (statement: string, values: readonly unknown[]) => {
        sql = statement;
        params = values;
        return { rows: [] } as never;
      }) as never,
    );

    assert.match(sql, /e\.id = \$2::uuid/);
    assert.match(sql, /v\.source_id = \$3::uuid/);
    assert.match(sql, /e\.edition = \$4/);
    assert.match(sql, /v\.language = \$5/);
    assert.deepEqual(params, [[generationId], entryId, sourceId, "5e", "ru"]);
  });

  it("binds source, version, edition, and language as exact scope filters", async () => {
    let sql = "";
    let params: readonly unknown[] = [];
    await resolveCompendiumEntities(
      "What is its range?",
      [generationId],
      { entryId, sourceId, versionId, edition: "5e", language: "en" },
      (async (statement: string, values: readonly unknown[]) => {
        sql = statement;
        params = values;
        return { rows: [] } as never;
      }) as never,
    );

    assert.match(sql, /e\.id = \$2::uuid/);
    assert.match(sql, /v\.source_id = \$3::uuid/);
    assert.match(sql, /v\.id = \$4::uuid/);
    assert.match(sql, /e\.edition = \$5/);
    assert.match(sql, /v\.language = \$6/);
    assert.deepEqual(params, [[generationId], entryId, sourceId, versionId, "5e", "en"]);
  });

  it("parameterizes apostrophe aliases without interpolating user text", async () => {
    const alias = "Mordenkainen's Sword";
    let sql = "";
    let params: readonly unknown[] = [];
    await resolveCompendiumEntities(alias, [generationId], undefined, (async (statement: string, values: readonly unknown[]) => {
      sql = statement;
      params = values;
      return { rows: [entityRow({ title: alias, aliases: ["Меч Морденкайнена"] })] } as never;
    }) as never);

    assert.equal(sql.includes(alias), false);
    assert.deepEqual(params, [[generationId], alias]);
  });

  it("returns indistinguishable results for inaccessible and nonexistent scoped entries", async () => {
    const resolveMissing = (scopedEntryId: string) => resolveCompendiumEntities(
      "What is it?",
      [generationId],
      { entryId: scopedEntryId, sourceId, versionId, edition: "5e", language: "en" },
      (async () => ({ rows: [] })) as never,
    );

    const inaccessible = await resolveMissing(entryId);
    const nonexistent = await resolveMissing("99999999-9999-4999-8999-999999999999");
    assert.deepEqual(inaccessible, { matches: [], candidates: [] });
    assert.deepEqual(nonexistent, inaccessible);
  });

  it("coalesces citations by chunk while retaining field and block evidence", async () => {
    const result = await resolveCompendiumEntities(
      "Shield",
      [generationId],
      undefined,
      (async () => ({
        rows: [
          entityRow(),
          entityRow({
            citation_id: "77777777-7777-4777-8777-777777777777",
            citation_kind: "block",
            field_path: null,
            citation_quote: "Shield has a range of Self.",
          }),
        ],
      })) as never,
    );

    assert.equal(result.matches.length, 1);
    assert.equal(result.candidates.length, 1);
    assert.deepEqual(
      result.candidates[0].entityEvidence?.map((evidence) => evidence.citationKind),
      ["field", "block"],
    );
  });
});

describe("entity query contracts", () => {
  it("validates canonical entry scopes", () => {
    assert.equal(isCompendiumEntryScope({ entryId, versionId, edition: "5.5e", language: "en" }), true);
    assert.equal(isCompendiumEntryScope({ entryId: "not-a-uuid" }), false);
    assert.equal(isCompendiumEntryScope({ entryId, edition: "4e" }), false);
  });

  it("detects edition and language conflicts without consulting entry existence", () => {
    const scope = { entryId, sourceId, versionId, edition: "5e", language: "en" } as const;
    assert.equal(entryScopeConflictsWithSelection(scope, { edition: "5e", language: "en" }), false);
    assert.equal(entryScopeConflictsWithSelection(scope, { edition: "5.5e" }), true);
    assert.equal(entryScopeConflictsWithSelection(scope, { language: "ru" }), true);
  });

  it("adds authorized bilingual names without duplicates", () => {
    const rewrite = enrichRewriteWithEntities(
      { original: "Shield", canonical: "shield spell", bilingual: [], expanded: ["Shield"] },
      [{
        entryId,
        entryType: "spell",
        canonicalKey: "shield",
        title: "Shield",
        aliases: ["Щит"],
        edition: "5e",
        language: "en",
        sourceId,
      }],
    );

    assert.deepEqual(rewrite.expanded, ["Shield", "Щит"]);
  });
});
