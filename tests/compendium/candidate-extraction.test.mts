import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  CandidateExtractionService,
  extractCandidates,
  markAmbiguousSourceLocalDuplicates,
  type ExtractionCorpus,
} from "../../src/server/compendium/candidate-extraction.ts";
import { parseDeterministicChunk } from "../../src/server/compendium/candidate-parsers.ts";
import { validateCandidateWire, type CandidateWire, type EvidenceChunk, type ExtractionBoundary } from "../../src/server/compendium/candidate-schema.ts";

const ids = {
  source: "10000000-0000-4000-8000-000000000001",
  otherSource: "10000000-0000-4000-8000-000000000002",
  file: "10000000-0000-4000-8000-000000000003",
  generation: "10000000-0000-4000-8000-000000000004",
  chunk: "10000000-0000-4000-8000-000000000005",
  otherChunk: "10000000-0000-4000-8000-000000000006",
  owner: "10000000-0000-4000-8000-000000000007",
  run: "10000000-0000-4000-8000-000000000008",
  lease: "10000000-0000-4000-8000-000000000009",
};

const openBoundary: ExtractionBoundary = {
  sourceId: ids.source,
  fileId: ids.file,
  generationId: ids.generation,
  edition: "5e",
  language: "en",
  accessTier: "open",
  shared: false,
  ownerUserId: null,
};

async function fixture(name: string): Promise<string> {
  return (await readFile(`tests/fixtures/candidate-extraction/${name}`, "utf8")).trim();
}

function chunk(quoteText: string, overrides: Partial<EvidenceChunk> = {}): EvidenceChunk {
  return { id: ids.chunk, chunkIndex: 0, pageNumber: 1, sectionHeading: null, quoteText, ...overrides };
}

function assertExactEvidence(candidate: CandidateWire, allowed: readonly EvidenceChunk[]): void {
  assert.equal(validateCandidateWire(candidate, allowed), candidate);
  const byId = new Map(allowed.map((item) => [item.id, item]));
  for (const citation of candidate.citations) {
    const text = Array.from(byId.get(citation.chunkId)!.quoteText);
    assert.equal(text.slice(citation.quoteSpanStart, citation.quoteSpanEnd).join(""), citation.quote);
  }
  assert.deepEqual(
    new Set(candidate.citations.map(({ fieldPath }) => fieldPath)),
    new Set(["$.entryType", "$.candidateKey", "$.title", "$.body", ...Object.keys(candidate.attributes).map((key) => `$.attributes.${key}`)]),
  );
}

test("deterministic spell parser extracts the English fixture with complete evidence", async () => {
  const evidence = chunk(await fixture("en-spell.txt"));
  const parsed = parseDeterministicChunk(evidence, "en");
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].method, "spell-parser");
  assert.equal(parsed[0].wire.candidateKey, "burning-hands");
  assert.deepEqual(parsed[0].wire.attributes, {
    level: 1,
    school: "evocation",
    castingTime: "1 action",
    range: "Self (15-foot cone)",
    duration: "Instantaneous",
    components: "V, S",
    concentration: false,
    ritual: false,
  });
  assertExactEvidence(parsed[0].wire, [evidence]);
});

test("deterministic stat-block parser extracts Russian text", async () => {
  const evidence = chunk(await fixture("ru-creature.txt"));
  const [parsed] = parseDeterministicChunk(evidence, "ru");
  assert.equal(parsed.method, "stat-block-parser");
  assert.equal(parsed.wire.candidateKey, "goblin");
  assert.deepEqual(parsed.wire.attributes, {
    size: "small",
    creatureType: "гуманоид",
    alignment: "нейтрально-злой",
    armorClass: 15,
    hitPoints: 7,
    challengeRating: 0.25,
    speed: "30 футов",
  });
  assertExactEvidence(parsed.wire, [evidence]);
});

test("Russian OCR fixture produces stable deterministic candidates and code-point spans", async () => {
  const evidence = chunk(await fixture("ru-ocr-spell.txt"));
  const first = parseDeterministicChunk(evidence, "ru");
  const second = parseDeterministicChunk(evidence, "ru");
  assert.deepEqual(first, second);
  assert.equal(first[0].wire.candidateKey, "ognennye-ladoni");
  assert.equal(first[0].wire.attributes.school, "evocation");
  assertExactEvidence(first[0].wire, [evidence]);

  const corpus: ExtractionCorpus = {
    boundary: { ...openBoundary, language: "ru" }, chunks: [evidence], existingCandidates: [],
  };
  assert.deepEqual(
    await extractCandidates(corpus, { modelVersion: "none" }),
    await extractCandidates(corpus, { modelVersion: "none" }),
  );
});

test("table and section parsers run before fallback", () => {
  const table = chunk("| Name | Cost | Weight |\n| --- | --- | --- |\n| Rope | 1 gp | 10 lb. |");
  const tableResult = parseDeterministicChunk(table, "en");
  assert.equal(tableResult[0].method, "table-parser");
  assert.deepEqual(tableResult[0].wire.attributes, { category: "other", costCp: 100, weightLb: 10 });
  assert.equal(parseDeterministicChunk(chunk("|Name|Cost|Weight|\n|---|---|---|\n|Rope|1 gp|10 lb.|"), "en")[0].method, "table-parser");

  const section = chunk("Rage\n1st-Level Barbarian Feature\nYou fight with primal ferocity.");
  const sectionResult = parseDeterministicChunk(section, "en");
  assert.equal(sectionResult[0].method, "section-parser");
  assert.deepEqual(sectionResult[0].wire.attributes, { level: 1, featureKind: "1st-Level Barbarian Feature" });
});

test("strict type-specific fallback accepts only complete exact evidence", async () => {
  const text = "Fallback Spell\n1st-level evocation\nCasting Time: 1 action\nRange: Self\nDuration: Instantaneous\nA fallback description.";
  const evidence = chunk(text);
  const paths = ["$.entryType", "$.candidateKey", "$.title", "$.body", "$.attributes.level", "$.attributes.school", "$.attributes.castingTime", "$.attributes.range", "$.attributes.duration", "$.attributes.components", "$.attributes.concentration", "$.attributes.ritual"];
  const wire = {
    entryType: "spell",
    candidateKey: "fallback-spell",
    title: "Fallback Spell",
    body: "A fallback description.",
    attributes: { level: 1, school: "evocation", castingTime: "1 action", range: "Self", duration: "Instantaneous", components: "V, S", concentration: false, ritual: false },
    citations: paths.map((fieldPath) => ({ fieldPath, chunkId: ids.chunk, quote: text, quoteSpanStart: 0, quoteSpanEnd: Array.from(text).length })),
  };
  let systemPrompt = "";
  const result = await extractCandidates({ boundary: openBoundary, chunks: [evidence], existingCandidates: [] }, {
    modelVersion: "test-model",
    llm: async (messages, options) => {
      systemPrompt = messages[0].content;
      assert.equal(options.temperature, 0);
      assert.equal(options.responseFormat, "json");
      assert.doesNotMatch(messages[1].content, new RegExp(ids.source));
      return { content: JSON.stringify(wire), model: "test-model" };
    },
  });
  assert.match(systemPrompt, /exactly one spell candidate/);
  assert.equal(result.rejections.length, 0);
  assert.equal(result.candidates[0].extraction.method, "llm");
  assert.deepEqual(result.candidates[0].provenance, openBoundary);
});

test("invalid model schema, disallowed chunks, bad quotes, and uncited fields are rejected", async () => {
  const text = "Broken Spell\n1st-level evocation\nCasting Time: 1 action";
  const evidence = chunk(text);
  const invalidOutputs: unknown[] = [
    { entryType: "spell", unexpected: true },
    {
      entryType: "spell", candidateKey: "broken-spell", title: "Broken Spell", body: "body",
      attributes: { level: 1, school: "evocation", castingTime: "1 action", range: "Self", duration: "Instantaneous", components: "V", concentration: false, ritual: false },
      citations: [{ fieldPath: "$.entryType", chunkId: ids.otherChunk, quote: text, quoteSpanStart: 0, quoteSpanEnd: Array.from(text).length }],
    },
    {
      entryType: "spell", candidateKey: "broken-spell", title: "Broken Spell", body: "body",
      attributes: { level: 1, school: "evocation", castingTime: "1 action", range: "Self", duration: "Instantaneous", components: "V", concentration: false, ritual: false },
      citations: [{ fieldPath: "$.entryType", chunkId: ids.chunk, quote: "not exact", quoteSpanStart: 0, quoteSpanEnd: 9 }],
    },
  ];
  for (const invalid of invalidOutputs) {
    const result = await extractCandidates({ boundary: openBoundary, chunks: [evidence], existingCandidates: [] }, {
      modelVersion: "test-model",
      llm: async () => ({ content: JSON.stringify(invalid), model: "test-model" }),
    });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.rejections.length, 1);
  }
});

test("matching is source-local and ambiguous duplicates are review-only", async () => {
  const evidence = chunk(await fixture("en-spell.txt"));
  const extracted = await extractCandidates({
    boundary: openBoundary,
    chunks: [evidence],
    existingCandidates: [
      { sourceId: ids.otherSource, entryType: "spell", candidateKey: "burning-hands" },
      { sourceId: ids.otherSource, entryType: "spell", candidateKey: "burning-hands" },
    ],
  }, { modelVersion: "none" });
  assert.equal(extracted.candidates[0].review.status, "ready");

  const ambiguous = markAmbiguousSourceLocalDuplicates(extracted.candidates, [
    { sourceId: ids.source, entryType: "spell", candidateKey: "burning-hands" },
    { sourceId: ids.source, entryType: "spell", candidateKey: "burning-hands" },
  ]);
  assert.equal(ambiguous[0].review.status, "ambiguous_duplicate");
  assert.match(ambiguous[0].review.reasons[0], /source-local/);

  const duplicateCurrent = markAmbiguousSourceLocalDuplicates([extracted.candidates[0], extracted.candidates[0]], []);
  assert.ok(duplicateCurrent.every(({ review }) => review.status === "ambiguous_duplicate"));
});

test("invalid edition, language, and access ownership boundaries fail closed", async () => {
  const evidence = chunk(await fixture("en-spell.txt"));
  const invalid = [
    { ...openBoundary, edition: "4e" },
    { ...openBoundary, language: "de" },
    { ...openBoundary, accessTier: "personal", ownerUserId: null },
    { ...openBoundary, accessTier: "premium", shared: false },
  ];
  for (const boundary of invalid) {
    await assert.rejects(extractCandidates({ boundary, chunks: [evidence], existingCandidates: [] } as ExtractionCorpus, { modelVersion: "none" }), /boundary|edition|language|access/i);
  }
});

test("corpus loading enforces successful PDF generation ownership and source-local baseline", async () => {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const service = new CandidateExtractionService(async (callback) => callback({
    async query(sql: string, values: unknown[] = []) {
      statements.push({ sql, values });
      if (sql.includes("FROM ingestion_generations")) return { rows: [{
        source_id: ids.source, file_id: ids.file, generation_id: ids.generation,
        edition: "5e", language: "en", access_tier: "personal", shared: false, owner_user_id: ids.owner,
      }] } as never;
      if (sql.includes("FROM chunks")) return { rows: [{ id: ids.chunk, chunk_index: 0, page_number: 1, section_heading: null, quote_text: "text" }] } as never;
      return { rows: [{ source_id: ids.source, entry_type: "spell", candidate_key: "existing" }] } as never;
    },
  }));
  const corpus = await service.loadCorpus(ids.generation);
  assert.equal(corpus.boundary.ownerUserId, ids.owner);
  assert.match(statements[0].sql, /generation\.status IN \('active', 'archived'\)/);
  assert.match(statements[0].sql, /job\.status = 'succeeded'/);
  assert.match(statements[0].sql, /file\.mime_type = 'application\/pdf'/);
  assert.match(statements[1].sql, /generation_id = \$1 AND file_id = \$2 AND source_id = \$3/);
  assert.deepEqual(statements[1].values, [ids.generation, ids.file, ids.source]);
  assert.match(statements[2].sql, /candidate\.source_id = \$1 AND run\.source_id = \$1/);
  assert.match(statements[2].sql, /run\.generation_id IS DISTINCT FROM \$2/);
  assert.deepEqual(statements[2].values, [ids.source, ids.generation]);
});

test("successful extraction is persisted through the #75 run checkpoints without publication", async () => {
  const evidence = chunk(await fixture("en-spell.txt"));
  const corpus: ExtractionCorpus = { boundary: openBoundary, chunks: [evidence], existingCandidates: [] };
  const calls: string[] = [];
  let recordedContent: Readonly<Record<string, unknown>> | null = null;
  const runs = {
    async createRun(input: { generationId?: string | null; inputSha256: string }) {
      calls.push("create");
      assert.equal(input.generationId, ids.generation);
      assert.match(input.inputSha256, /^[0-9a-f]{64}$/);
      return { id: ids.run, sourceId: ids.source, fileId: ids.file, generationId: ids.generation, status: "pending", checkpoint: "created" } as const;
    },
    async claimRun() { calls.push("claim"); return { run: { id: ids.run, sourceId: ids.source, fileId: ids.file, generationId: ids.generation, status: "running", checkpoint: "created" } as const, leaseToken: ids.lease, completed: false }; },
    async heartbeat() { calls.push("heartbeat"); },
    async recordOccurrences(_runId: string, _lease: string, occurrences: readonly { chunkId?: string | null }[]) { calls.push("occurrences"); assert.equal(occurrences[0].chunkId, ids.chunk); },
    async addDiagnostic() { calls.push("diagnostic"); },
    async computeCandidateDiff(_runId: string, _lease: string, candidates: readonly { content: Readonly<Record<string, unknown>> }[]) {
      calls.push("diff"); recordedContent = candidates[0].content;
      return [{ id: "candidate", candidateKey: "burning-hands", diffStatus: "new", contentSha256: "a".repeat(64) }] as const;
    },
    async completeRun() { calls.push("complete"); },
    async failRun() { calls.push("fail"); },
  };
  const service = new CandidateExtractionService(async () => { throw new Error("loadCorpus was not stubbed"); }, runs);
  service.loadCorpus = async () => corpus;
  const result = await service.run({ generationId: ids.generation, actor: "test", modelVersion: "none" });
  assert.deepEqual(calls, ["create", "claim", "occurrences", "diff", "complete"]);
  assert.equal(result.candidates[0].candidateKey, "burning-hands");
  assert.deepEqual((recordedContent as { provenance: ExtractionBoundary }).provenance, openBoundary);
  assert.ok(!calls.includes("publication"));
});
