/**
 * Tests for RAG answer pipeline: prompt construction, citation mapping,
 * and LLM response parsing.
 *
 * generateAnswer itself depends on the full retrieval pipeline (DB + vector),
 * so it's tested through integration/e2e rather than unit tests. Here we
 * test all the pure sub-components.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  parseLlmResponse,
  mapCitations,
  type RawLlmCitation,
} from "../../src/server/rag/format.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

// ---------- Helpers ----------

function makeChunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-1",
    sourceId: "src-1",
    fileId: "file-1",
    text: "A creature can take a reaction on another creature's turn.",
    quoteText: "A creature can take a reaction on another creature's turn.",
    sectionHeading: "Reactions",
    pageNumber: 73,
    edition: "5e",
    language: "en",
    sourceTitle: "Basic Rules",
    sourceCategory: "core_rules",
    accessTier: "open",
    score: 0.95,
    strategy: "keyword",
    ...overrides,
  };
}

// ---------- buildSystemPrompt ----------

describe("buildSystemPrompt", () => {
  it("includes English instruction for en language", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(prompt.includes("Respond in English"));
  });

  it("includes Russian instruction for ru language", () => {
    const prompt = buildSystemPrompt("ru");
    assert.ok(prompt.includes("русском"));
  });

  it("includes JSON structure requirement", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(prompt.includes('"answer"'));
    assert.ok(prompt.includes('"citations"'));
    assert.ok(prompt.includes('"confident"'));
  });

  it("includes 'no outside knowledge' rule", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(
      prompt.includes("ONLY from the provided source") ||
        prompt.includes("only from the provided source"),
    );
  });

  it("includes 'no support' fallback instruction", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(
      prompt.includes("cannot answer") ||
        prompt.includes("not find") ||
        prompt.includes("could not find"),
    );
  });
});

// ---------- formatRetrievalContext ----------

describe("formatRetrievalContext", () => {
  it("returns no-sources message for empty chunks", () => {
    const result = formatRetrievalContext([]);
    assert.equal(result, "No relevant sources found.");
  });

  it("formats a single chunk with all fields", () => {
    const chunk = makeChunk();
    const result = formatRetrievalContext([chunk]);
    assert.ok(result.includes("[Source 1]"));
    assert.ok(result.includes("Title: Basic Rules"));
    assert.ok(result.includes("Edition: 5e"));
    assert.ok(result.includes("Page: 73"));
    assert.ok(result.includes("Section: Reactions"));
    assert.ok(result.includes("Category: core_rules"));
    assert.ok(result.includes("Quote:"));
  });

  it("omits page when null", () => {
    const chunk = makeChunk({ pageNumber: null });
    const result = formatRetrievalContext([chunk]);
    assert.ok(!result.includes("Page:"));
  });

  it("omits section when null", () => {
    const chunk = makeChunk({ sectionHeading: null });
    const result = formatRetrievalContext([chunk]);
    assert.ok(!result.includes("Section:"));
  });

  it("formats multiple chunks with sequential numbering", () => {
    const chunks = [
      makeChunk({ sourceTitle: "Source A" }),
      makeChunk({ sourceTitle: "Source B" }),
    ];
    const result = formatRetrievalContext(chunks);
    assert.ok(result.includes("[Source 1]"));
    assert.ok(result.includes("[Source 2]"));
    assert.ok(result.includes("Source A"));
    assert.ok(result.includes("Source B"));
  });
});

// ---------- buildUserMessage ----------

describe("buildUserMessage", () => {
  it("includes the query", () => {
    const msg = buildUserMessage("What is a reaction?", [makeChunk()]);
    assert.ok(msg.includes("What is a reaction?"));
  });

  it("includes formatted context", () => {
    const msg = buildUserMessage("test", [makeChunk()]);
    assert.ok(msg.includes("[Source 1]"));
    assert.ok(msg.includes("Basic Rules"));
  });

  it("includes Available sources header", () => {
    const msg = buildUserMessage("test", [makeChunk()]);
    assert.ok(msg.includes("Available sources:"));
  });
});

// ---------- parseLlmResponse ----------

describe("parseLlmResponse", () => {
  it("parses valid JSON response", () => {
    const input = JSON.stringify({
      answer: "A reaction is a special action.",
      confident: true,
      citations: [{ quote: "A reaction...", sourceTitle: "Basic Rules" }],
    });
    const result = parseLlmResponse(input);
    assert.equal(result.answer, "A reaction is a special action.");
    assert.equal(result.confident, true);
    assert.equal(result.citations?.length, 1);
  });

  it("strips markdown code block wrapping with language tag", () => {
    const json = JSON.stringify({
      answer: "Test answer",
      confident: false,
      citations: [],
    });
    const wrapped = "```json\n" + json + "\n```";
    const result = parseLlmResponse(wrapped);
    assert.equal(result.answer, "Test answer");
    assert.equal(result.confident, false);
  });

  it("handles plain code block without language tag", () => {
    const json = JSON.stringify({ answer: "X", confident: true, citations: [] });
    const wrapped = "```\n" + json + "\n```";
    const result = parseLlmResponse(wrapped);
    assert.equal(result.answer, "X");
  });

  it("returns raw text as answer on invalid JSON", () => {
    const result = parseLlmResponse("This is not JSON");
    assert.equal(result.answer, "This is not JSON");
    assert.equal(result.confident, false);
    assert.deepEqual(result.citations, []);
  });

  it("handles empty citations array", () => {
    const input = JSON.stringify({ answer: "No info", confident: false, citations: [] });
    const result = parseLlmResponse(input);
    assert.deepEqual(result.citations, []);
  });

  it("handles missing optional fields", () => {
    const input = JSON.stringify({ answer: "Partial answer" });
    const result = parseLlmResponse(input);
    assert.equal(result.answer, "Partial answer");
    assert.equal(result.confident, undefined);
    assert.equal(result.citations, undefined);
  });

  it("handles JSON with leading/trailing whitespace", () => {
    const input = "  \n  " + JSON.stringify({ answer: "Trimmed", confident: true, citations: [] }) + "  \n  ";
    const result = parseLlmResponse(input);
    assert.equal(result.answer, "Trimmed");
    assert.equal(result.confident, true);
  });

  it("drops model-provided structured claims and invalid field types", () => {
    const result = parseLlmResponse(JSON.stringify({
      answer: { range: "Self" },
      confident: "yes",
      entity: { range: "Self" },
      citations: [{ quote: "Range: Self", page: "12", structuredClaim: { range: "Self" } }],
    }));

    assert.deepEqual(result, { citations: [{ quote: "Range: Self" }] });
  });
});

// ---------- mapCitations ----------

describe("mapCitations", () => {
  it("maps citation by exact source title match", () => {
    const chunks = [makeChunk({ sourceTitle: "Basic Rules", sourceId: "src-1", fileId: "file-1" })];
    const raw = [{ quote: "A creature can take a reaction", sourceTitle: "Basic Rules" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceTitle, "Basic Rules");
    assert.equal(result[0].sourceId, "src-1");
    assert.equal(result[0].fileId, "file-1");
  });

  it("maps citation by case-insensitive source title", () => {
    const chunks = [makeChunk({ sourceTitle: "Basic Rules" })];
    const raw = [{ quote: "A creature can take a reaction", sourceTitle: "basic rules" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceTitle, "Basic Rules");
  });

  it("maps a normalized contiguous quote substring and derives the source quote", () => {
    const chunks = [
      makeChunk({
        sourceTitle: "Player's Handbook",
        quoteText: "A creature can take a reaction on another creature's turn.",
      }),
    ];
    const raw = [{ quote: "A creature can take a reaction on another" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceTitle, "Player's Handbook");
    assert.equal(result[0].quote, "A creature can take a reaction on another creature's turn.");
  });

  it("omits unmatched citations without source support", () => {
    const chunks = [makeChunk({ sourceTitle: "Basic Rules" })];
    const raw = [{ quote: "Something unrelated", sourceTitle: "Unknown Source" }];
    const result = mapCitations(raw, chunks);
    assert.deepEqual(result, []);
  });

  it("does not accept an unsupported short quote by incidental overlap", () => {
    assert.deepEqual(
      mapCitations([{ quote: "A", sourceTitle: "Basic Rules" }], [makeChunk()]),
      [],
    );
  });

  it("rejects a divergent quote that only shares a long prefix", () => {
    const chunk = makeChunk({ quoteText: "A creature can take a reaction on another creature's turn." });
    assert.deepEqual(
      mapCitations([{ quote: "A creature can take a reaction that deals damage" }], [chunk]),
      [],
    );
  });

  it("propagates only field evidence supporting the final quote", () => {
    const chunks = [makeChunk({
      strategy: "entity",
      entityEvidence: [
        {
          entryId: "entry-1",
          entryType: "spell",
          canonicalKey: "shield",
          title: "Shield",
          citationId: "citation-1",
          citationKind: "field",
          fieldPath: "$.range",
          quote: "Range: Self",
        },
        {
          entryId: "entry-1",
          entryType: "spell",
          canonicalKey: "shield",
          title: "Shield",
          citationId: "citation-2",
          citationKind: "field",
          fieldPath: "$.duration",
          quote: "Duration: 1 round",
        },
      ],
    })];

    const result = mapCitations(
      [{ quote: "Range: Self", sourceTitle: "Basic Rules" }],
      chunks,
    );

    assert.equal(result.length, 1);
    assert.deepEqual(result[0].entityEvidence?.map((evidence) => evidence.fieldPath), ["$.range"]);
  });

  it("omits an entity field claim without a supporting carried citation", () => {
    const chunks = [makeChunk({
      strategy: "entity",
      entityEvidence: [{
        entryId: "entry-1",
        entryType: "spell",
        canonicalKey: "shield",
        title: "Shield",
        citationId: "citation-1",
        citationKind: "field",
        fieldPath: "$.range",
        quote: "Range: Self",
      }],
    })];

    assert.deepEqual(
      mapCitations([{ quote: "Damage: 4d6", sourceTitle: "Basic Rules" }], chunks),
      [],
    );
  });

  it("skips citations without a quote", () => {
    const chunks = [makeChunk()];
    const raw = [{ sourceTitle: "Basic Rules" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result.length, 0);
  });

  it("uses chunk metadata for page/section when LLM omits them", () => {
    const chunks = [makeChunk({ pageNumber: 73, sectionHeading: "Reactions" })];
    const raw = [{ quote: "A creature can take a reaction", sourceTitle: "Basic Rules" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result[0].page, 73);
    assert.equal(result[0].section, "Reactions");
  });

  it("ignores LLM-provided page/section in favor of chunk metadata", () => {
    const chunks = [makeChunk({ pageNumber: 73, sectionHeading: "Reactions" })];
    const raw = [{ quote: "A creature can take a reaction", sourceTitle: "Basic Rules", page: 99, section: "Combat" }];
    const result = mapCitations(raw, chunks);
    assert.equal(result[0].page, 73);
    assert.equal(result[0].section, "Reactions");
  });

  it("maps multiple citations to different chunks", () => {
    const chunks = [
      makeChunk({ sourceId: "src-1", sourceTitle: "Basic Rules" }),
      makeChunk({
        sourceId: "src-2",
        sourceTitle: "Player's Handbook",
        quoteText: "Different text for testing overlap matching here",
      }),
    ];
    const raw = [
      { quote: "A creature can take a reaction", sourceTitle: "Basic Rules" },
      { quote: "Different text for testing overlap" },
    ];
    const result = mapCitations(raw, chunks);
    assert.equal(result.length, 2);
    assert.equal(result[0].sourceId, "src-1");
    assert.equal(result[1].sourceId, "src-2");
  });

  it("returns empty array for empty raw citations", () => {
    const result = mapCitations([], [makeChunk()]);
    assert.equal(result.length, 0);
  });

  it("returns empty array for null citations", () => {
    const result = mapCitations(null as unknown as readonly RawLlmCitation[], [makeChunk()]);
    assert.equal(result.length, 0);
  });
});
