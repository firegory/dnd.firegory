import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  mapCitations,
  parseLlmResponse,
  type RawLlmCitation,
} from "../../src/server/rag/format.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-secret",
    sourceId: "source-secret",
    fileId: "file-secret",
    text: "Armor Class 18. Speed 30 ft. Hit Points 45.",
    quoteText: "Armor Class 18. Speed 30 ft. Hit Points 45.",
    sectionHeading: "Guardian stat block",
    pageNumber: 42,
    edition: "5e",
    language: "en",
    sourceTitle: "Open Rules",
    sourceCategory: "core_rules",
    accessTier: "premium",
    score: 1,
    strategy: "entity",
    entityEvidence: [{
      entryId: "entry-secret",
      entryType: "monster",
      canonicalKey: "guardian",
      title: "Guardian",
      citationId: "citation-secret",
      citationKind: "block",
      fieldPath: null,
      quote: "Armor Class 18",
    }],
    ...overrides,
  };
}

function reference(overrides: Partial<RawLlmCitation> = {}): RawLlmCitation {
  return {
    contextId: "C1",
    quote: "Armor Class 18",
    sourceTitle: "Open Rules",
    edition: "5e",
    language: "en",
    page: 42,
    section: "Guardian stat block",
    ...overrides,
  };
}

describe("RAG prompt contract", () => {
  it("requests direct RU/EN claim synthesis and readable stat blocks", () => {
    const en = buildSystemPrompt("en");
    const ru = buildSystemPrompt("ru");
    assert.match(en, /Write every claim in English/);
    assert.match(ru, /русском языке/);
    assert.match(en, /Answer the user's question directly/);
    assert.match(en, /tables and stat blocks in natural, readable sentences/);
    assert.match(en, /Unknown fields are forbidden/);
  });

  it("supplies stable public context IDs without RBAC or entity internals", () => {
    const context = formatRetrievalContext([chunk()]);
    assert.match(context, /"contextId": "C1"/);
    assert.match(context, /"sourceTitle": "Open Rules"/);
    assert.doesNotMatch(context, /premium|source-secret|file-secret|entry-secret|citation-secret|accessTier|entityEvidence/);
  });

  it("keeps filters outside prompt construction by accepting only retrieved chunks", () => {
    const message = buildUserMessage("What are its defenses?", [chunk({ edition: "5.5e", language: "ru" })]);
    assert.match(message, /What are its defenses/);
    assert.match(message, /"edition": "5.5e"/);
    assert.match(message, /"language": "ru"/);
    assert.doesNotMatch(message, /role|owner|generationId/);
  });
});

describe("closed provider JSON parser", () => {
  it("accepts the exact claim shape", () => {
    const parsed = parseLlmResponse(JSON.stringify({
      claims: [{ text: "The guardian has AC 18.", citations: [reference()] }],
    }));
    assert.equal(parsed.rejected, false);
    assert.equal(parsed.claims[0].text, "The guardian has AC 18.");
  });

  it("rejects malformed JSON instead of exposing raw provider text", () => {
    const parsed = parseLlmResponse("The guardian has AC 18 {not json");
    assert.deepEqual(parsed, { claims: [], rejected: true });
  });

  it("rejects unknown fields, empty claims, oversized claims, and uncited claims", () => {
    const parsed = parseLlmResponse(JSON.stringify({
      claims: [
        { text: "Invented", citations: [], hidden: true },
        { text: " ", citations: [reference()] },
        { text: "x".repeat(601), citations: [reference()] },
        { text: "Uncited", citations: [] },
      ],
    }));
    assert.equal(parsed.rejected, true);
    assert.deepEqual(parsed.claims, []);
  });

  it("drops an invalid reference while retaining another reference for confidence degradation", () => {
    const parsed = parseLlmResponse(JSON.stringify({
      claims: [{
        text: "The guardian has AC 18.",
        citations: [reference(), { ...reference({ contextId: "C2" }), extra: "forbidden" }],
      }],
    }));
    assert.equal(parsed.rejected, true);
    assert.equal(parsed.claims[0].citations.length, 1);
  });
});

describe("authoritative citation mapping", () => {
  it("accepts only a normalized contiguous quote on the referenced chunk", () => {
    const mapped = mapCitations([reference({ quote: "armor   class 18" })], [chunk()]);
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].quote, "Armor Class 18");
    assert.equal(mapped[0].page, 42);
  });

  it("rejects a fabricated quote sharing a source prefix", () => {
    assert.deepEqual(mapCitations([reference({ quote: "Armor Class 18 and immunity to fire" })], [chunk()]), []);
  });

  it("rejects invented context IDs and inaccessible chunks", () => {
    assert.deepEqual(mapCitations([reference({ contextId: "C2" })], [chunk()]), []);
    assert.deepEqual(mapCitations([reference()], []), []);
  });

  it("rejects invented page, section, title, edition, or language metadata", () => {
    for (const invalid of [
      reference({ page: 99 }),
      reference({ section: "Combat" }),
      reference({ sourceTitle: "Private Rules" }),
      reference({ edition: "5.5e" }),
      reference({ language: "ru" }),
    ]) assert.deepEqual(mapCitations([invalid], [chunk()]), []);
  });
});
