import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildSystemPrompt,
  buildUserMessage,
  formatRetrievalContext,
  parseLlmResponse,
  resolveContextReferences,
} from "../../src/server/rag/format.ts";
import { validateClaimSupport } from "../../src/server/rag/support.ts";
import type { RetrievalCandidate } from "../../src/server/retrieval/types.ts";

function chunk(overrides: Partial<RetrievalCandidate> = {}): RetrievalCandidate {
  return {
    chunkId: "chunk-secret", sourceId: "source-secret", fileId: "file-secret",
    text: "Lemure. Armor Class 7. Hit Points 13. Speed 15 ft.",
    quoteText: "Lemure. Armor Class 7. Hit Points 13. Speed 15 ft.",
    sectionHeading: "Lemure", pageNumber: 42, edition: "5e", language: "en",
    sourceTitle: "Open Rules", sourceCategory: "core_rules", accessTier: "premium",
    score: 1, strategy: "entity",
    entityEvidence: [{
      entryId: "entry-secret", entryType: "monster", canonicalKey: "lemure", title: "Lemure",
      citationId: "citation-secret", citationKind: "block", fieldPath: null, quote: "Armor Class 7",
    }],
    ...overrides,
  };
}

describe("ID-only provider contract", () => {
  it("prompts for direct RU/EN claims and context IDs only", () => {
    const en = buildSystemPrompt("en");
    const ru = buildSystemPrompt("ru");
    assert.match(en, /Write every claim in English/);
    assert.match(ru, /русском языке/);
    assert.match(en, /"references": \["C1"\]/);
    assert.match(en, /Never return quotes, source metadata, locations/);
    assert.doesNotMatch(en, /"citations"/);
  });

  it("does not send RBAC or entity internals to the model", () => {
    const context = formatRetrievalContext([chunk()]);
    assert.match(context, /"contextId": "C1"/);
    assert.doesNotMatch(context, /premium|source-secret|file-secret|entry-secret|citation-secret|accessTier|entityEvidence/);
    assert.doesNotMatch(buildUserMessage("Question", [chunk()]), /role|owner|generationId/);
  });

  it("accepts only the exact root and claim fields", () => {
    assert.deepEqual(parseLlmResponse(JSON.stringify({
      claims: [{ text: "Lemure Armor Class is 7.", references: ["C1"] }],
    })), {
      claims: [{ text: "Lemure Armor Class is 7.", references: ["C1"] }],
      rejected: false,
    });

    const unknown = parseLlmResponse(JSON.stringify({
      claims: [{ text: "Lemure Armor Class is 7.", references: ["C1"], quote: "Armor Class" }],
    }));
    assert.deepEqual(unknown, { claims: [], rejected: true });
  });

  it("rejects an entire claim for duplicate or malformed references", () => {
    for (const references of [["C1", "C1"], ["C0"], ["chunk-secret"], ["C1", 2]]) {
      const parsed = parseLlmResponse(JSON.stringify({ claims: [{ text: "Lemure Armor Class is 7.", references }] }));
      assert.deepEqual(parsed, { claims: [], rejected: true });
    }
  });

  it("rejects malformed JSON, empty claims, and oversized claims", () => {
    assert.deepEqual(parseLlmResponse("not json"), { claims: [], rejected: true });
    const parsed = parseLlmResponse(JSON.stringify({ claims: [
      { text: " ", references: ["C1"] },
      { text: "x".repeat(601), references: ["C1"] },
      { text: "No source", references: [] },
    ] }));
    assert.deepEqual(parsed, { claims: [], rejected: true });
  });

  it("resolves references atomically against only supplied chunks", () => {
    assert.deepEqual(resolveContextReferences(["C1"], [chunk()])?.map((item) => item.chunkId), ["chunk-secret"]);
    assert.equal(resolveContextReferences(["C1", "C2"], [chunk()]), undefined);
    assert.equal(resolveContextReferences(["C2"], [chunk()]), undefined);
  });
});

describe("deterministic claim support", () => {
  it("rejects fire-immunity laundering through an Armor Class citation", () => {
    const result = validateClaimSupport("The Lemure has Fire Immunity.", [chunk({ quoteText: "Lemure. Armor Class 7." })], "en");
    assert.equal(result.supported, false);
    assert.deepEqual(result.unsupportedTokens.sort(), ["fire", "has", "immunity"]);
  });

  it("rejects swapped Armor Class and Hit Points values even when every token exists", () => {
    const result = validateClaimSupport("Lemure Armor Class is 13 and Hit Points are 7.", [chunk()], "en");
    assert.equal(result.supported, false);
    assert.deepEqual(result.unsupportedTokens, []);
  });

  it("keeps signed, decimal, and fractional numbers indivisible", () => {
    const numbers = chunk({ quoteText: "Armor Class +3. Speed 1.5 ft. Challenge Rating 1/2." });
    assert.equal(validateClaimSupport("AC is +3.", [numbers], "en").supported, true);
    assert.equal(validateClaimSupport("Speed is 1.5 feet.", [numbers], "en").supported, true);
    assert.equal(validateClaimSupport("Challenge Rating is 1/2.", [numbers], "en").supported, true);
    assert.equal(validateClaimSupport("Armor Class +1. Speed 3.5 feet. Challenge Rating 2/1.", [numbers], "en").supported, false);
  });

  it("rejects unsupported negation", () => {
    const result = validateClaimSupport("The Lemure is not immune to fire.", [chunk({ quoteText: "The Lemure is immune to fire." })], "en");
    assert.equal(result.supported, false);
    assert.deepEqual(result.unsupportedTokens, ["not"]);
  });

  it("rejects punctuation-only and connector-only claims", () => {
    assert.equal(validateClaimSupport("...", [chunk()], "en").supported, false);
    assert.equal(validateClaimSupport("It is.", [chunk()], "en").supported, false);
  });

  it("allows supported unit spelling without weakening number-unit association", () => {
    assert.equal(validateClaimSupport("Its Speed is 15 feet.", [chunk()], "en").supported, true);
    assert.equal(validateClaimSupport("Its Speed is 13 feet.", [chunk()], "en").supported, false);
  });

  it("handles Russian claims conservatively and preserves stat associations", () => {
    const ru = chunk({
      quoteText: "Лемур. Класс Доспеха 7. Хиты 13.", sectionHeading: "Лемур",
      language: "ru", sourceTitle: "Открытые правила",
    });
    assert.equal(validateClaimSupport("Лемур: Класс Доспеха 7.", [ru], "ru").supported, true);
    assert.equal(validateClaimSupport("Лемур: Хиты 13.", [ru], "ru").supported, true);
    assert.equal(validateClaimSupport("Класс Доспеха лемура 13. Хиты 7.", [ru], "ru").supported, false);
    assert.equal(validateClaimSupport("Лемур имеет иммунитет к огню.", [ru], "ru").supported, false);
  });

  it("rejects reversed Imp/Lemure comparisons", () => {
    const comparison = chunk({ sectionHeading: null, quoteText: "Imp has higher Armor Class than Lemure." });
    assert.equal(validateClaimSupport("Imp has higher AC than Lemure.", [comparison], "en").supported, true);
    assert.equal(validateClaimSupport("Lemure has higher AC than Imp.", [comparison], "en").supported, false);
  });

  it("rejects distributed negation and cross-entity poison resistance", () => {
    const evidence = chunk({
      sectionHeading: null,
      quoteText: "Lemure is resistant to fire. Imp is not resistant to poison.",
    });
    assert.equal(validateClaimSupport("Imp is not resistant to poison.", [evidence], "en").supported, true);
    assert.equal(validateClaimSupport("Lemure is not resistant to fire.", [evidence], "en").supported, false);
    assert.equal(validateClaimSupport("Lemure is resistant to poison.", [evidence], "en").supported, false);
  });

  it("rejects cross-entity AC values and Bite/Claw value swaps", () => {
    const creatures = chunk({
      sectionHeading: null,
      quoteText: "Lemure Armor Class 7. Imp Armor Class 13. Bite deals 7 damage. Claw deals 5 damage.",
    });
    assert.equal(validateClaimSupport("Lemure AC is 7.", [creatures], "en").supported, true);
    assert.equal(validateClaimSupport("Lemure AC is 13.", [creatures], "en").supported, false);
    assert.equal(validateClaimSupport("Bite deals 7 damage.", [creatures], "en").supported, true);
    assert.equal(validateClaimSupport("Claw deals 7 damage.", [creatures], "en").supported, false);

    const denseRow = chunk({ sectionHeading: null, quoteText: "Lemure | AC 7 | Imp | AC 13" });
    assert.equal(validateClaimSupport("Lemure AC is 13.", [denseRow], "en").supported, false);
  });

  it("does not take a value from a later stat label", () => {
    const incomplete = chunk({ sectionHeading: null, quoteText: "Lemure | AC natural armor | HP 13" });
    assert.equal(validateClaimSupport("Lemure AC is 13.", [incomplete], "en").supported, false);
  });

  it("rejects swapped Russian Speed and Armor Class values in one table row", () => {
    const row = chunk({
      sectionHeading: "Лемур", language: "ru", sourceTitle: "Открытые правила",
      quoteText: "Лемур | КД 13 | Скорость 30 футов",
    });
    assert.equal(validateClaimSupport("Лемур: КД 13.", [row], "ru").supported, true);
    assert.equal(validateClaimSupport("Лемур: Скорость 30 футов.", [row], "ru").supported, true);
    assert.equal(validateClaimSupport("Лемур: КД 30.", [row], "ru").supported, false);
    assert.equal(validateClaimSupport("Лемур: Скорость 13 футов.", [row], "ru").supported, false);
  });
});
