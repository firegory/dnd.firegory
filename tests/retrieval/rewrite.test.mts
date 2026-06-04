import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { collectVectorQueries, type RewrittenQuery } from "../../src/server/retrieval/rewrite.ts";

function makeRewritten(overrides: Partial<RewrittenQuery> = {}): RewrittenQuery {
  return {
    original: "monk",
    canonical: "monk class",
    bilingual: ["монах"],
    expanded: ["ki", "martial arts"],
    ...overrides,
  };
}

describe("collectVectorQueries", () => {
  it("returns all unique queries from original, canonical, bilingual, and expanded", () => {
    const rewritten = makeRewritten();
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, ["monk", "monk class", "монах", "ki", "martial arts"]);
  });

  it("deduplicates case-insensitively", () => {
    const rewritten = makeRewritten({
      original: "Monk",
      canonical: "monk",
      bilingual: ["MONK"],
      expanded: ["Monk"],
    });
    const queries = collectVectorQueries(rewritten);

    assert.strictEqual(queries.length, 1);
    assert.strictEqual(queries[0], "Monk");
  });

  it("filters out empty strings", () => {
    const rewritten = makeRewritten({
      original: "  ",
      canonical: "monk",
      bilingual: ["", "  "],
      expanded: [""],
    });
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, ["monk"]);
  });

  it("returns empty array when all fields are empty", () => {
    const rewritten: RewrittenQuery = {
      original: "",
      canonical: "",
      bilingual: [],
      expanded: [],
    };
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, []);
  });

  it("keeps canonical even when it differs from original", () => {
    const rewritten = makeRewritten({
      original: "Who is monk",
      canonical: "monk class",
      bilingual: [],
      expanded: [],
    });
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, ["Who is monk", "monk class"]);
  });

  it("deduplicates bilingual against canonical", () => {
    const rewritten = makeRewritten({
      original: "monk",
      canonical: "monk",
      bilingual: ["monk", "монах"],
      expanded: [],
    });
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, ["monk", "монах"]);
  });

  it("deduplicates expanded against canonical", () => {
    const rewritten = makeRewritten({
      original: "sneak attack",
      canonical: "sneak attack rogue",
      bilingual: [],
      expanded: ["sneak attack rogue", "rogue"],
    });
    const queries = collectVectorQueries(rewritten);

    assert.deepStrictEqual(queries, ["sneak attack", "sneak attack rogue", "rogue"]);
  });
});
