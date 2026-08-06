import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { CompendiumEdition, CompendiumEntryType, CompendiumLanguage } from "./service.ts";

export const EXTRACTION_SCHEMA_VERSION = 1 as const;
export const EXTRACTION_PARSER_VERSION = "1";
export const EXTRACTION_PROMPT_VERSION = "1";

export type ExtractionMethod = "section-parser" | "table-parser" | "spell-parser" | "stat-block-parser" | "llm";
export type CandidateReviewStatus = "ready" | "ambiguous_duplicate";

export type CandidateCitation = Readonly<{
  fieldPath: string;
  chunkId: string;
  quote: string;
  quoteSpanStart: number;
  quoteSpanEnd: number;
}>;

export type ExtractionBoundary = Readonly<{
  sourceId: string;
  fileId: string;
  generationId: string;
  edition: CompendiumEdition;
  language: CompendiumLanguage;
  accessTier: "open" | "premium" | "personal";
  shared: boolean;
  ownerUserId: string | null;
}>;

export type CandidateWire = Readonly<{
  entryType: CompendiumEntryType;
  candidateKey: string;
  title: string;
  body: string;
  attributes: Readonly<Record<string, unknown>>;
  citations: readonly CandidateCitation[];
}>;

export type ExtractedCandidate = CandidateWire & Readonly<{
  schemaVersion: typeof EXTRACTION_SCHEMA_VERSION;
  provenance: ExtractionBoundary;
  extraction: Readonly<{
    method: ExtractionMethod;
    parserVersion: string;
    promptVersion: string;
    modelVersion: string;
  }>;
  review: Readonly<{
    status: CandidateReviewStatus;
    reasons: readonly string[];
  }>;
}>;

export type EvidenceChunk = Readonly<{
  id: string;
  chunkIndex: number;
  pageNumber: number | null;
  sectionHeading: string | null;
  quoteText: string;
}>;

const citationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["fieldPath", "chunkId", "quote", "quoteSpanStart", "quoteSpanEnd"],
  properties: {
    fieldPath: { type: "string", pattern: "^\\$\\.(?:entryType|candidateKey|title|body|attributes\\.[A-Za-z][A-Za-z0-9]*)$" },
    chunkId: { type: "string", format: "uuid" },
    quote: { type: "string", minLength: 1 },
    quoteSpanStart: { type: "integer", minimum: 0 },
    quoteSpanEnd: { type: "integer", minimum: 1 },
  },
} as const;

const stringField = { type: "string", minLength: 1 } as const;
const nullableStringField = { type: ["string", "null"], minLength: 1 } as const;
const nullableIntegerField = { type: ["integer", "null"], minimum: 0, maximum: 2147483647 } as const;
const attributesByType = {
  spell: {
    type: "object", additionalProperties: false,
    required: ["level", "school", "castingTime", "range", "duration", "components", "concentration", "ritual"],
    properties: {
      level: { type: "integer", minimum: 0, maximum: 9 },
      school: { enum: ["abjuration", "conjuration", "divination", "enchantment", "evocation", "illusion", "necromancy", "transmutation"] },
      castingTime: stringField, range: stringField, duration: stringField, components: stringField,
      concentration: { type: "boolean" }, ritual: { type: "boolean" },
    },
  },
  creature: {
    type: "object", additionalProperties: false,
    required: ["size", "creatureType", "alignment", "armorClass", "hitPoints", "challengeRating", "speed"],
    properties: {
      size: { enum: ["tiny", "small", "medium", "large", "huge", "gargantuan"] },
      creatureType: stringField, alignment: nullableStringField,
      armorClass: { type: "integer", minimum: 0, maximum: 50 },
      hitPoints: { type: "integer", minimum: 1, maximum: 2147483647 },
      challengeRating: { enum: [0, 0.125, 0.25, 0.5, ...Array.from({ length: 30 }, (_, index) => index + 1)] },
      speed: stringField,
    },
  },
  equipment: {
    type: "object", additionalProperties: false,
    required: ["category", "costCp", "weightLb"],
    properties: {
      category: { enum: ["adventuring_gear", "ammunition", "armor", "focus", "mount", "tool", "vehicle", "weapon", "other"] },
      costCp: nullableIntegerField,
      weightLb: { type: ["number", "null"], minimum: 0, maximum: 9999999.999 },
    },
  },
  feature: {
    type: "object", additionalProperties: false,
    required: ["level", "featureKind"],
    properties: {
      level: { type: "integer", minimum: 1, maximum: 20 }, featureKind: stringField,
    },
  },
  item: {
    type: "object", additionalProperties: false,
    required: ["category", "rarity", "requiresAttunement"],
    properties: {
      category: { enum: ["armor", "potion", "ring", "rod", "scroll", "staff", "wand", "weapon", "wondrous", "other"] },
      rarity: { enum: ["common", "uncommon", "rare", "very_rare", "legendary", "artifact", "varies"] },
      requiresAttunement: { type: "boolean" },
    },
  },
  class: {
    type: "object", additionalProperties: false,
    required: ["hitDie", "primaryAbility", "spellcastingAbility"],
    properties: { hitDie: { enum: [6, 8, 10, 12] }, primaryAbility: stringField, spellcastingAbility: nullableStringField },
  },
  species: {
    type: "object", additionalProperties: false,
    required: ["size", "speed"],
    properties: { size: { enum: ["tiny", "small", "medium", "large", "huge", "gargantuan"] }, speed: { type: "integer", minimum: 1 } },
  },
  background: {
    type: "object", additionalProperties: false,
    required: ["abilityScores", "skillProficiencies"],
    properties: { abilityScores: stringField, skillProficiencies: stringField },
  },
  feat: {
    type: "object", additionalProperties: false,
    required: ["category", "prerequisiteLevel", "prerequisiteText", "repeatable"],
    properties: {
      category: { enum: ["origin", "general", "fighting_style", "epic_boon"] },
      prerequisiteLevel: { type: ["integer", "null"], minimum: 1, maximum: 20 },
      prerequisiteText: nullableStringField, repeatable: { type: "boolean" },
    },
  },
} as const;

function schemaForType(entryType: CompendiumEntryType): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["entryType", "candidateKey", "title", "body", "attributes", "citations"],
    properties: {
      entryType: { const: entryType },
      candidateKey: { type: "string", pattern: "^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$" },
      title: stringField,
      body: stringField,
      attributes: attributesByType[entryType],
      citations: { type: "array", minItems: 1, items: citationSchema },
    },
  };
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validators = new Map<CompendiumEntryType, ReturnType<typeof ajv.compile>>();
for (const entryType of Object.keys(attributesByType) as CompendiumEntryType[]) {
  validators.set(entryType, ajv.compile(schemaForType(entryType)));
}

export class CandidateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CandidateValidationError";
  }
}

export function validateCandidateWire(value: unknown, chunks: readonly EvidenceChunk[]): CandidateWire {
  if (!isRecord(value) || typeof value.entryType !== "string") {
    throw new CandidateValidationError("Candidate output must be an object with an entryType.");
  }
  const validator = validators.get(value.entryType as CompendiumEntryType);
  if (!validator || !validator(value)) {
    throw new CandidateValidationError(`Candidate output failed its type schema: ${ajv.errorsText(validator?.errors ?? [])}`);
  }

  const candidate = value as CandidateWire;
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const requiredPaths = new Set([
    "$.entryType", "$.candidateKey", "$.title", "$.body",
    ...Object.keys(candidate.attributes).map((key) => `$.attributes.${key}`),
  ]);
  const citedPaths = new Set<string>();
  for (const citation of candidate.citations) {
    if (!requiredPaths.has(citation.fieldPath)) {
      throw new CandidateValidationError(`Citation path ${citation.fieldPath} does not identify a candidate field.`);
    }
    const chunk = chunksById.get(citation.chunkId);
    if (!chunk) throw new CandidateValidationError(`Citation uses disallowed chunk ${citation.chunkId}.`);
    const codePoints = Array.from(chunk.quoteText);
    if (citation.quoteSpanEnd <= citation.quoteSpanStart || citation.quoteSpanEnd > codePoints.length
      || codePoints.slice(citation.quoteSpanStart, citation.quoteSpanEnd).join("") !== citation.quote) {
      throw new CandidateValidationError(`Citation for ${citation.fieldPath} is not an exact quote span.`);
    }
    citedPaths.add(citation.fieldPath);
  }
  const missing = [...requiredPaths].filter((path) => !citedPaths.has(path));
  if (missing.length > 0) throw new CandidateValidationError(`Every derived field must be cited; missing ${missing.join(", ")}.`);
  return candidate;
}

export function makeCitation(chunk: EvidenceChunk, fieldPath: string, quote: string): CandidateCitation {
  const start = chunk.quoteText.indexOf(quote);
  if (start < 0) throw new CandidateValidationError(`Parser quote for ${fieldPath} is absent from chunk ${chunk.id}.`);
  const quoteSpanStart = Array.from(chunk.quoteText.slice(0, start)).length;
  return { fieldPath, chunkId: chunk.id, quote, quoteSpanStart, quoteSpanEnd: quoteSpanStart + Array.from(quote).length };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
