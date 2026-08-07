import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { getGuide, listGuides } from "../../src/server/compendium/guides.ts";
import { CompendiumReadService } from "../../src/server/compendium/read-service.ts";

describe("localized beginner guide access", () => {
  it("omits premium guide links and direct content for regular users", () => {
    assert.deepEqual(listGuides("en", "user").map(({ slug }) => slug), ["starter", "basics"]);
    assert.equal(getGuide("character-creation", "en", "user"), null);
    assert.equal(getGuide("character-creation", "ru", "premium")?.locale, "ru");
    assert.equal(getGuide("character-creation", "en", "admin")?.locale, "en");
  });

  it("provides attribution and an HTTPS citation for every rendered block", () => {
    for (const role of ["user", "premium", "admin"] as const) {
      for (const locale of ["ru", "en"] as const) {
        for (const guide of listGuides(locale, role)) {
          assert.equal(guide.review.status, "approved");
          assert.ok(guide.blocks.length > 0);
          for (const block of guide.blocks) {
            assert.ok(block.citation.attribution.trim());
            assert.ok(block.citation.locator.trim());
            assert.equal(new URL(block.citation.url).protocol, "https:");
          }
        }
      }
    }
  });

  it("filters landing counts at the source SQL boundary", async () => {
    let statement = "";
    let values: readonly unknown[] = [];
    const service = new CompendiumReadService({
      async query(sql: string, params: readonly unknown[] = []) {
        statement = sql;
        values = params;
        return { rows: [{ entry_type: "spell", count: "12" }] } as never;
      },
    });
    assert.deepEqual(
      await service.listEntryTypeCounts({ role: "user", userId: "regular" }, { edition: "5.5e", language: "en" }),
      [{ entryType: "spell", count: 12 }],
    );
    assert.match(statement, /s\.access_tier = 'open'/);
    assert.match(statement, /GROUP BY entry_type/);
    assert.ok(values.includes("5.5e"));
    assert.ok(values.includes("en"));
  });

  it("keeps direct routes authenticated, localized, and fail-closed", async () => {
    const root = new URL("../../", import.meta.url);
    const [landing, guide, category, entry] = await Promise.all([
      readFile(new URL("src/app/[locale]/compendium/page.tsx", root), "utf8"),
      readFile(new URL("src/app/[locale]/compendium/guides/[slug]/page.tsx", root), "utf8"),
      readFile(new URL("src/app/[locale]/compendium/categories/[category]/page.tsx", root), "utf8"),
      readFile(new URL("src/app/[locale]/compendium/entries/[identifier]/page.tsx", root), "utf8"),
    ]);
    for (const route of [landing, guide, category, entry]) {
      assert.match(route, /requireUser\(\)/);
      assert.match(route, /isGuideLocale/);
      assert.match(route, /LocaleSync/);
    }
    assert.match(guide, /if \(!document\) notFound\(\)/);
    assert.match(category, /if \(result\.count === 0\) notFound\(\)/);
    assert.match(category, /entries\/\$\{entry\.id\}/);
    assert.doesNotMatch(category, /entries\/\$\{encodeURIComponent\(entry\.slug\)\}/);
    assert.match(entry, /CompendiumNotFoundError/);
    assert.match(entry, /citationPreviewHref\(\{ chunkId, sourceId, fileId, page \}\)/);
    assert.match(entry, /publication\.originUrl/);
    assert.match(entry, /citationNumber\(citation, "page"\)/);
    assert.match(entry, /citationText\(citation, "section"\)/);
  });
});
