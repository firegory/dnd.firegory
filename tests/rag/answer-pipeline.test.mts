/**
 * Integration tests for the RAG answer pipeline.
 *
 * Tests the full answer flow from retrieval context formatting through
 * citation mapping, verifying that the pipeline components work together
 * correctly. The LLM and retrieval layers are mocked where needed.
 *
 * These tests focus on:
 * - System prompt construction for different languages
 * - Retrieval context formatting with various chunk shapes
 * - LLM response parsing (including edge cases)
 * - Citation matching from LLM output to retrieval candidates
 * - End-to-end format → parse → map pipeline
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
    text: "Armor Class represents how well a creature avoids being hit in combat.",
    quoteText: "Armor Class represents how well a creature avoids being hit in combat.",
    sectionHeading: "Combat",
    pageNumber: 42,
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

// ---------- Tests ----------

describe("RAG pipeline: system prompt construction", () => {
  it("includes English language instruction", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(prompt.includes("Respond in English"));
    assert.ok(prompt.includes("JSON"));
  });

  it("includes Russian language instruction", () => {
    const prompt = buildSystemPrompt("ru");
    assert.ok(prompt.includes("Отвечай на русском"));
    assert.ok(prompt.includes("JSON"));
  });

  it("contains citation-first rules", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(prompt.includes("citation") || prompt.includes("quote"), "Should mention citations/quotes");
    assert.ok(prompt.includes("confident"), "Should include confidence field in schema");
  });

  it("includes not-found response format", () => {
    const prompt = buildSystemPrompt("en");
    assert.ok(
      prompt.includes("cannot answer") || prompt.includes("could not find"),
      "Should include fallback response format",
    );
  });
});

describe("RAG pipeline: retrieval context formatting", () => {
  it("formats single chunk with all fields", () => {
    const chunk = makeChunk();
    const context = formatRetrievalContext([chunk]);

    assert.ok(context.includes("[Source 1]"));
    assert.ok(context.includes("Title: Basic Rules"));
    assert.ok(context.includes("Edition: 5e"));
    assert.ok(context.includes("Language: en"));
    assert.ok(context.includes("Page: 42"));
    assert.ok(context.includes("Section: Combat"));
    assert.ok(context.includes('Quote: "Armor Class'));
  });

  it("omits page when null", () => {
    const chunk = makeChunk({ pageNumber: null });
    const context = formatRetrievalContext([chunk]);

    assert.ok(!context.includes("Page:"), "Should not show Page: when null");
  });

  it("omits section when null", () => {
    const chunk = makeChunk({ sectionHeading: null });
    const context = formatRetrievalContext([chunk]);

    assert.ok(!context.includes("Section:"), "Should not show Section: when null");
  });

  it("formats multiple chunks with numbering", () => {
    const chunks = [
      makeChunk({ chunkId: "c1", sourceTitle: "Basic Rules" }),
      makeChunk({ chunkId: "c2", sourceTitle: "Player's Handbook" }),
      makeChunk({ chunkId: "c3", sourceTitle: "Monster Manual" }),
    ];
    const context = formatRetrievalContext(chunks);

    assert.ok(context.includes("[Source 1]"));
    assert.ok(context.includes("[Source 2]"));
    assert.ok(context.includes("[Source 3]"));
    assert.ok(context.includes("Basic Rules"));
    assert.ok(context.includes("Player's Handbook"));
    assert.ok(context.includes("Monster Manual"));
  });

  it("returns no-sources message for empty chunks", () => {
    const context = formatRetrievalContext([]);
    assert.ok(context.toLowerCase().includes("no") && context.toLowerCase().includes("source"));
  });
});

describe("RAG pipeline: user message construction", () => {
  it("combines query with context", () => {
    const chunk = makeChunk();
    const message = buildUserMessage("What is AC?", [chunk]);

    assert.ok(message.includes("What is AC?"));
    assert.ok(message.includes("[Source 1]"));
    assert.ok(message.includes("Basic Rules"));
  });

  it("includes no-sources context when chunks empty", () => {
    const message = buildUserMessage("What is AC?", []);
    assert.ok(message.includes("What is AC?"));
    assert.ok(message.toLowerCase().includes("no"));
  });
});

describe("RAG pipeline: LLM response parsing", () => {
  it("parses valid JSON response", () => {
    const raw = JSON.stringify({
      answer: "AC is Armor Class.",
      confident: true,
      citations: [{ quote: "Armor Class...", sourceTitle: "Basic Rules" }],
    });

    const parsed = parseLlmResponse(raw);
    assert.equal(parsed.answer, "AC is Armor Class.");
    assert.equal(parsed.confident, true);
    assert.equal(parsed.citations!.length, 1);
  });

  it("strips markdown code block wrapper", () => {
    const json = JSON.stringify({
      answer: "Test",
      confident: true,
      citations: [],
    });
    const raw = "```json\n" + json + "\n```";

    const parsed = parseLlmResponse(raw);
    assert.equal(parsed.answer, "Test");
    assert.equal(parsed.confident, true);
  });

  it("handles response without explicit code block language", () => {
    const json = JSON.stringify({
      answer: "Test",
      confident: false,
      citations: [],
    });
    const raw = "```\n" + json + "\n```";

    const parsed = parseLlmResponse(raw);
    assert.equal(parsed.answer, "Test");
  });

  it("returns raw text as answer on parse failure", () => {
    const raw = "This is not JSON at all";
    const parsed = parseLlmResponse(raw);

    assert.equal(parsed.answer, raw);
    assert.equal(parsed.confident, false);
    assert.equal(parsed.citations!.length, 0);
  });

  it("handles empty citations array", () => {
    const raw = JSON.stringify({
      answer: "No info found.",
      confident: false,
      citations: [],
    });

    const parsed = parseLlmResponse(raw);
    assert.equal(parsed.citations!.length, 0);
  });

  it("handles missing citations field", () => {
    const raw = JSON.stringify({
      answer: "Partial response.",
      confident: true,
    });

    const parsed = parseLlmResponse(raw);
    assert.equal(parsed.answer, "Partial response.");
    assert.equal(parsed.confident, true);
  });
});

describe("RAG pipeline: citation mapping", () => {
  it("maps citation to matching chunk by source title", () => {
    const chunks = [
      makeChunk({ sourceTitle: "Basic Rules", chunkId: "c1" }),
      makeChunk({ sourceTitle: "Player's Handbook", chunkId: "c2" }),
    ];

    const rawCitations: RawLlmCitation[] = [
      { quote: "Armor Class represents how well", sourceTitle: "Basic Rules", page: 42 },
    ];

    const citations = mapCitations(rawCitations, chunks);
    assert.equal(citations.length, 1);
    assert.equal(citations[0].sourceTitle, "Basic Rules");
    assert.equal(citations[0].sourceId, "src-1");
    assert.equal(citations[0].fileId, "file-1");
    assert.equal(citations[0].page, 42);
  });

  it("falls back to quote text matching when title doesn't match", () => {
    const chunks = [
      makeChunk({
        quoteText: "The dragon breathes fire dealing 12d6 damage.",
        sourceTitle: "Monster Manual",
      }),
    ];

    const rawCitations: RawLlmCitation[] = [
      {
        quote: "The dragon breathes fire dealing 12d6 damage.",
        sourceTitle: "Monstrous Compendium", // Wrong title
      },
    ];

    const citations = mapCitations(rawCitations, chunks);
    assert.equal(citations.length, 1);
    // Should match via quote overlap
    assert.equal(citations[0].sourceTitle, "Monster Manual");
  });

  it("omits unmatched citation without available source support", () => {
    const chunks: RetrievalCandidate[] = [];

    const rawCitations: RawLlmCitation[] = [
      { quote: "Some unknown quote.", sourceTitle: "Unknown Book" },
    ];

    const citations = mapCitations(rawCitations, chunks);
    assert.deepEqual(citations, []);
  });

  it("skips citations without quote", () => {
    const rawCitations: RawLlmCitation[] = [
      { sourceTitle: "Basic Rules" }, // No quote
    ];

    const citations = mapCitations(rawCitations, []);
    assert.equal(citations.length, 0);
  });

  it("maps multiple citations to different chunks", () => {
    const chunks = [
      makeChunk({ sourceTitle: "Basic Rules", chunkId: "c1", fileId: "f1" }),
      makeChunk({
        sourceTitle: "Player's Handbook",
        chunkId: "c2",
        fileId: "f2",
        pageNumber: 123,
        sectionHeading: "Spells",
      }),
    ];

    const rawCitations: RawLlmCitation[] = [
      { quote: "Armor Class represents how well", sourceTitle: "Basic Rules", page: 42 },
      { quote: "Armor Class represents how well", sourceTitle: "Player's Handbook" },
    ];

    const citations = mapCitations(rawCitations, chunks);
    assert.equal(citations.length, 2);
    assert.equal(citations[0].sourceTitle, "Basic Rules");
    assert.equal(citations[1].sourceTitle, "Player's Handbook");
    // PHB citation should get section from chunk since LLM didn't provide it
    assert.equal(citations[1].section, "Spells");
  });
});

describe("RAG pipeline: end-to-end format → parse → map", () => {
  it("processes a complete RAG response cycle", () => {
    const chunks = [
      makeChunk({
        sourceTitle: "Basic Rules",
        quoteText: "An attack roll is a d20 + proficiency + ability modifier.",
        pageNumber: 74,
        sectionHeading: "Making an Attack",
      }),
    ];

    // Build prompt and context
    const systemPrompt = buildSystemPrompt("en");
    const userMessage = buildUserMessage("How do attack rolls work?", chunks);

    assert.ok(systemPrompt.includes("English"));
    assert.ok(userMessage.includes("How do attack rolls work?"));
    assert.ok(userMessage.includes("Basic Rules"));
    assert.ok(userMessage.includes("Making an Attack"));

    // Simulate LLM response
    const llmRaw = JSON.stringify({
      answer: "An attack roll is d20 + proficiency bonus + ability modifier.",
      confident: true,
      citations: [
        {
          quote: "An attack roll is a d20 + proficiency + ability modifier.",
          sourceTitle: "Basic Rules",
          page: 74,
          section: "Making an Attack",
        },
      ],
    });

    const parsed = parseLlmResponse(llmRaw);
    assert.equal(parsed.confident, true);

    const citations = mapCitations(parsed.citations, chunks);
    assert.equal(citations.length, 1);
    assert.equal(citations[0].sourceTitle, "Basic Rules");
    assert.equal(citations[0].edition, "5e");
    assert.equal(citations[0].page, 74);
    assert.equal(citations[0].section, "Making an Attack");
    assert.ok(citations[0].sourceId, "Should have internal source ID");
    assert.ok(citations[0].fileId, "Should have internal file ID");
  });

  it("handles Russian language RAG cycle", () => {
    const chunks = [
      makeChunk({
        sourceTitle: "Базовые правила",
        language: "ru",
        quoteText: "Класс брони показывает, насколько существо защищено от попаданий.",
        pageNumber: 15,
        sectionHeading: "Бой",
      }),
    ];

    const systemPrompt = buildSystemPrompt("ru");
    assert.ok(systemPrompt.includes("русском"), "Russian prompt should contain Russian instruction");

    const userMessage = buildUserMessage("Что такое класс брони?", chunks);
    assert.ok(userMessage.includes("Что такое класс брони?"));

    const llmRaw = JSON.stringify({
      answer: "Класс брони (КБ) показывает, насколько сложно поразить существо атакой.",
      confident: true,
      citations: [
        {
          quote: "Класс брони показывает, насколько существо защищено от попаданий.",
          sourceTitle: "Базовые правила",
          page: 15,
          section: "Бой",
        },
      ],
    });

    const parsed = parseLlmResponse(llmRaw);
    const citations = mapCitations(parsed.citations, chunks);

    assert.equal(citations[0].sourceTitle, "Базовые правила");
    assert.equal(citations[0].language, "ru");
    assert.equal(citations[0].section, "Бой");
  });
});
