import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";

import { captureRetrievalSnapshot } from "../../src/server/retrieval/snapshot.ts";

const oldGeneration = "11111111-1111-4111-8111-111111111111";
const newGeneration = "22222222-2222-4222-8222-222222222222";

test("captured mapping remains fixed when activation occurs between components", async () => {
  let activeGeneration = oldGeneration;
  const snapshot = await captureRetrievalSnapshot(
    "s.access_tier = 'open'",
    [],
    (async () => ({ rows: [{ generation_id: activeGeneration }] })) as never,
  );
  activeGeneration = newGeneration;
  assert.deepEqual(snapshot.generationIds, [oldGeneration]);
  assert.equal(activeGeneration, newGeneration);
});

test("search count and rows use the same captured generation mapping", async () => {
  const search = await readFile("src/server/search/service.ts", "utf8");
  assert.match(search, /const snapshot = await/);
  assert.equal((search.match(/snapshot\.generationIds/g) ?? []).length, 2);
  assert.match(search, /const allParams = \[snapshot\.generationIds/);
  assert.match(search, /allParams\.slice\(0, -2\)/);
  assert.equal((search.match(/c\.generation_id = ANY\(\$1::uuid\[\]\)/g) ?? []).length, 2);
});

test("hybrid keyword and every vector variant receive one snapshot object", async () => {
  const pipeline = await readFile("src/server/retrieval/pipeline.ts", "utf8");
  assert.equal((pipeline.match(/captureRetrievalSnapshot/g) ?? []).length, 2);
  assert.match(pipeline, /generationIds: snapshot\.generationIds/);
  assert.match(pipeline, /keyword[^\n]*retrievalParams/);
  assert.match(pipeline, /vector[^\n]*retrievalParams/);
});
