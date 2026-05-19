/**
 * Tests for the text chunking module.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  chunkPage,
  chunkPages,
  cleanQuoteText,
  type ChunkInput,
} from "../../src/worker/ingestion/chunking.ts";

describe("cleanQuoteText", () => {
  it("should collapse multiple newlines", () => {
    const result = cleanQuoteText("hello\n\n\n\nworld");
    assert.equal(result, "hello\n\nworld");
  });

  it("should collapse spaces and tabs", () => {
    const result = cleanQuoteText("hello  \t  world");
    assert.equal(result, "hello world");
  });

  it("should trim whitespace", () => {
    const result = cleanQuoteText("  hello world  ");
    assert.equal(result, "hello world");
  });

  it("should handle CRLF line endings", () => {
    const result = cleanQuoteText("hello\r\nworld");
    assert.equal(result, "hello\nworld");
  });
});

describe("chunkPage", () => {
  it("should return empty array for empty text", () => {
    const result = chunkPage({ pageNumber: 1, text: "" }, 0);
    assert.deepEqual(result, []);
  });

  it("should return empty array for whitespace-only text", () => {
    const result = chunkPage({ pageNumber: 1, text: "   \n\n  " }, 0);
    assert.deepEqual(result, []);
  });

  it("should return single chunk for short text", () => {
    const text = "Hello world, this is a short text.";
    const result = chunkPage({ pageNumber: 1, text }, 0);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, text);
    assert.equal(result[0].pageNumber, 1);
    assert.equal(result[0].chunkIndex, 0);
  });

  it("should split long text into multiple chunks", () => {
    const text = "A ".repeat(2000); // ~4000 chars
    const result = chunkPage({ pageNumber: 1, text }, 0, { targetChunkSize: 1000, overlapSize: 200, minChunkSize: 50 });
    assert.ok(result.length >= 2, `Expected at least 2 chunks, got ${result.length}`);
    // All chunks should have text
    for (const chunk of result) {
      assert.ok(chunk.text.trim().length > 0, "Chunk should not be empty");
      assert.equal(chunk.pageNumber, 1);
    }
  });

  it("should prefer paragraph boundaries for splitting", () => {
    const paragraphA = "A".repeat(600);
    const paragraphB = "B".repeat(600);
    const text = paragraphA + "\n\n" + paragraphB;
    const result = chunkPage({ pageNumber: 1, text }, 0, { targetChunkSize: 700, overlapSize: 100, minChunkSize: 50 });

    // Should split at the paragraph boundary
    assert.ok(result.length >= 2, `Expected at least 2 chunks, got ${result.length}`);
    // First chunk should contain the first paragraph
    assert.ok(result[0].text.includes("A"), "First chunk should contain paragraph A");
  });

  it("should respect globalChunkIndex offset", () => {
    const text = "Hello world";
    const result = chunkPage({ pageNumber: 1, text }, 5);
    assert.equal(result[0].chunkIndex, 5);
  });

  it("should set text span offsets", () => {
    const text = "Hello world";
    const result = chunkPage({ pageNumber: 1, text }, 0);
    assert.equal(result[0].textSpanStart, 0);
    assert.equal(result[0].textSpanEnd, text.length);
  });

  it("should include section heading", () => {
    const text = "Some content here";
    const result = chunkPage({ pageNumber: 3, text, sectionHeading: "Combat" }, 0);
    assert.equal(result[0].sectionHeading, "Combat");
    assert.equal(result[0].pageNumber, 3);
  });

  it("should set null section heading when not provided", () => {
    const text = "Some content here";
    const result = chunkPage({ pageNumber: 1, text }, 0);
    assert.equal(result[0].sectionHeading, null);
  });

  it("should produce quote-safe text for each chunk", () => {
    const text = "A".repeat(1500);
    const result = chunkPage({ pageNumber: 1, text }, 0, { targetChunkSize: 800, overlapSize: 100, minChunkSize: 50 });
    for (const chunk of result) {
      assert.ok(chunk.quoteText.length > 0, "quoteText should not be empty");
      assert.equal(chunk.quoteText, cleanQuoteText(chunk.text));
    }
  });

  it("should merge short tail into previous chunk", () => {
    const mainPart = "A".repeat(900);
    const tailPart = "B"; // Very short tail
    const text = mainPart + "\n\n" + tailPart;
    const result = chunkPage({ pageNumber: 1, text }, 0, {
      targetChunkSize: 1000,
      overlapSize: 100,
      minChunkSize: 50,
    });

    // The short tail should be merged into the previous chunk
    const lastChunk = result[result.length - 1];
    assert.ok(lastChunk.text.includes("B"), "Last chunk should include the short tail");
  });
});

describe("chunkPages", () => {
  it("should handle empty pages array", () => {
    const result = chunkPages([]);
    assert.deepEqual(result, []);
  });

  it("should chunk multiple pages with sequential global indices", () => {
    const pages: ChunkInput[] = [
      { pageNumber: 1, text: "A".repeat(600) },
      { pageNumber: 2, text: "B".repeat(600) },
      { pageNumber: 3, text: "C".repeat(600) },
    ];

    const result = chunkPages(pages, { targetChunkSize: 500, overlapSize: 50, minChunkSize: 50 });

    // Check sequential chunk indices
    for (let i = 0; i < result.length; i++) {
      assert.equal(result[i].chunkIndex, i, `Chunk at index ${i} should have chunkIndex ${i}`);
    }

    // Check page numbers are preserved
    const pageNumbers = new Set(result.map((c) => c.pageNumber));
    assert.ok(pageNumbers.has(1));
    assert.ok(pageNumbers.has(2));
    assert.ok(pageNumbers.has(3));
  });

  it("should skip pages with empty text", () => {
    const pages: ChunkInput[] = [
      { pageNumber: 1, text: "Hello" },
      { pageNumber: 2, text: "" },
      { pageNumber: 3, text: "World" },
    ];

    const result = chunkPages(pages);
    assert.equal(result.length, 2);
    assert.equal(result[0].pageNumber, 1);
    assert.equal(result[1].pageNumber, 3);
  });

  it("should produce sequential chunkIndex across pages", () => {
    const pages: ChunkInput[] = [
      { pageNumber: 1, text: "A".repeat(1200) },
      { pageNumber: 2, text: "B".repeat(300) },
    ];

    const result = chunkPages(pages, { targetChunkSize: 500, overlapSize: 50, minChunkSize: 50 });

    for (let i = 0; i < result.length; i++) {
      assert.equal(result[i].chunkIndex, i);
    }
  });
});
