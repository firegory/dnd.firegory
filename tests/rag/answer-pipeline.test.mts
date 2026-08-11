import assert from "node:assert/strict";
import { it } from "node:test";

import { buildUserMessage, parseLlmResponse } from "../../src/server/rag/format.ts";
import { groundGeneratedAnswer } from "../../src/server/rag/ground.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

it("runs authorized context through ID-only JSON to linked synthesis end to end", () => {
  const chunks: RetrievalCandidate[] = [{
    chunkId: "c1", sourceId: "s1", fileId: "f1", text: "A reaction happens in response to a trigger.",
    quoteText: "A reaction happens in response to a trigger.", sectionHeading: "Reactions", pageNumber: 73,
    edition: "5e", language: "en", sourceTitle: "Basic Rules", sourceCategory: "core_rules",
    accessTier: "open", score: 1, strategy: "keyword",
  }];
  assert.match(buildUserMessage("What is a reaction?", chunks), /"segmentId": "C1:S1"/);

  const parsed = parseLlmResponse(JSON.stringify({ selections: ["C1:S1"] }));
  const result = groundGeneratedAnswer(parsed, chunks, "en");
  assert.equal(result.answer, "A reaction happens in response to a trigger.");
  assert.equal(result.claims[0].citations[0], result.citations[0]);
  assert.equal(result.confident, true);
});
