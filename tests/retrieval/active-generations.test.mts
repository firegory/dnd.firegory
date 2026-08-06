import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const keyword = await readFile("src/server/retrieval/keyword.ts", "utf8");
const vector = await readFile("src/server/retrieval/vector.ts", "utf8");
const search = await readFile("src/server/search/service.ts", "utf8");
const admin = await readFile("src/server/admin/source-view.ts", "utf8");
const citation = await readFile("src/server/citations/preview.ts", "utf8");
const actions = await readFile("src/server/ingestion/actions.ts", "utf8");
const persistence = await readFile("src/server/embeddings/provider.ts", "utf8");
const pipeline = await readFile("src/worker/ingestion/pipeline.ts", "utf8");

test("all retrieval queries join chunks to the file active generation", () => {
  const activeJoin = /JOIN files f ON f\.id = c\.file_id AND f\.active_generation_id = c\.generation_id/g;
  assert.equal((keyword.match(activeJoin) ?? []).length, 1);
  assert.equal((vector.match(activeJoin) ?? []).length, 1);
  assert.equal((search.match(activeJoin) ?? []).length, 2, "count and result SQL must use the same snapshot");
});

test("relevant admin previews and counts exclude staged and archived tails", () => {
  assert.match(admin, /active_generation_id = c\.generation_id/);
  assert.match(admin, /active_generation_id = p\.generation_id/);
});

test("historical citation IDs remain authorized and resolvable", () => {
  const chunkLookup = citation.slice(citation.indexOf("export async function lookupChunkBbox"));
  assert.match(chunkLookup, /AND c\.id = \$\$\{chunkParam\}/);
  assert.doesNotMatch(chunkLookup, /active_generation_id/);
  assert.match(chunkLookup, /JOIN files f ON f\.id = c\.file_id/);
});

test("reprocess retains active rows and artifacts until activation", () => {
  const reprocess = actions.slice(actions.indexOf("export async function reprocessSource"), actions.indexOf("// Delete"));
  assert.doesNotMatch(reprocess, /DELETE FROM (?:chunks|pages|documents)/);
  assert.doesNotMatch(reprocess, /await rm\(/);
  assert.match(reprocess, /createIngestionJob/);
});

test("staged persistence is generation-scoped so replacement tails cannot mix", () => {
  assert.equal((persistence.match(/ON CONFLICT \(generation_id, chunk_index\)/g) ?? []).length, 2);
  assert.equal((persistence.match(/ON CONFLICT \(generation_id, page_number\)/g) ?? []).length, 1);
  assert.doesNotMatch(persistence, /ON CONFLICT \(file_id, (?:chunk_index|page_number)\)/);
});

test("pipeline validates quality before atomic activation and cleans failures", () => {
  const quality = pipeline.indexOf("generateQualityReport");
  const rejectFailed = pipeline.indexOf('qualityReport.overall.status === "failed"');
  const activate = pipeline.indexOf("await activateGeneration(stagedGenerationId)");
  assert.ok(quality < rejectFailed && rejectFailed < activate);
  assert.match(pipeline, /await discardStagedGeneration\(generationId, jobArtifactsDir\)/);
});
