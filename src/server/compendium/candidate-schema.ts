import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import type { CompendiumEdition, CompendiumEntryType, CompendiumLanguage } from "./service.ts";
import { creatureEvidencePaths, validateCreatureProjection } from "./creature-schema.ts";
import { creatureFieldEvidenceSupports } from "./creature-evidence.ts";
import { canonicalFlatAttributes, FLAT_ENTRY_TYPES, type FlatEntryType } from "./flat-schema.ts";

export const EXTRACTION_SCHEMA_VERSION = 1 as const;
export const EXTRACTION_PARSER_VERSION = "2";
export const EXTRACTION_PROMPT_VERSION = "3";

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
    fieldPath: { type: "string", pattern: "^\\$\\.(?:entryType|candidateKey|title|body|attributes\\.[A-Za-z][A-Za-z0-9]*(?:\\.[A-Za-z][A-Za-z0-9]*|\\[[0-9]+\\])*)$" },
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
      classes: { type: "array", items: stringField, uniqueItems: true },
    },
  },
  creature: {
    anyOf: [{
      type: "object", additionalProperties: false,
      required: ["size", "creatureType", "alignment", "armorClass", "hitPoints", "challengeRating", "speed"],
      properties: {
        size: { enum: ["tiny", "small", "medium", "large", "huge", "gargantuan"] }, creatureType: stringField,
        alignment: nullableStringField, armorClass: { type: "integer", minimum: 1, maximum: 50 },
        hitPoints: { type: "integer", minimum: 1, maximum: 2147483647 },
        challengeRating: { enum: [0, 0.125, 0.25, 0.5, ...Array.from({ length: 30 }, (_, index) => index + 1)] }, speed: stringField,
      },
    }, {
    type: "object", additionalProperties: false,
    required: ["size", "creatureType", "alignment", "armorClass", "hitPoints", "challengeRating", "speeds", "abilities", "saves", "skills", "damageResistances", "damageImmunities", "conditionImmunities", "senses", "passivePerception", "languages", "traits", "actions", "bonusActions", "reactions", "legendaryActions"],
    properties: {
      size: { enum: ["tiny", "small", "medium", "large", "huge", "gargantuan"] },
      creatureType: stringField, alignment: nullableStringField,
      armorClass: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "integer", minimum: 1, maximum: 50 }, note: stringField } } },
      hitPoints: { type: "object", additionalProperties: false, required: ["average"], properties: { average: { type: "integer", minimum: 1 }, formula: stringField } },
      challengeRating: { type: "object", additionalProperties: false, required: ["numerator", "denominator"], properties: { numerator: { type: "integer", minimum: 0, maximum: 30 }, denominator: { enum: [1, 2, 4, 8] } } },
      speeds: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["mode", "distance", "unit"], properties: { mode: { enum: ["walk", "burrow", "climb", "fly", "swim"] }, distance: { type: "integer", minimum: 1 }, unit: { enum: ["ft", "m"] }, note: stringField } } },
      abilities: { type: "object", additionalProperties: false, required: ["str", "dex", "con", "int", "wis", "cha"], properties: Object.fromEntries(["str", "dex", "con", "int", "wis", "cha"].map((key) => [key, { type: "integer", minimum: 1, maximum: 30 }])) },
      saves: { type: "object", additionalProperties: { type: "integer", minimum: -30, maximum: 30 } },
      skills: { type: "object", additionalProperties: { type: "integer", minimum: -30, maximum: 30 } },
      damageResistances: { type: "array", items: stringField, uniqueItems: true }, damageImmunities: { type: "array", items: stringField, uniqueItems: true },
      conditionImmunities: { type: "array", items: stringField, uniqueItems: true }, senses: { type: "array", items: stringField, uniqueItems: true },
      passivePerception: { type: "integer", minimum: 0, maximum: 100 }, languages: { type: "array", items: stringField, uniqueItems: true },
      traits: blockList(), actions: blockList(), bonusActions: blockList(), reactions: blockList(), legendaryActions: blockList(),
    },
    }],
  },
  equipment: {
    type: "object", additionalProperties: false,
    required: ["category"],
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
    properties: {
      hitDie: { enum: [6, 8, 10, 12] }, primaryAbility: stringField, spellcastingAbility: nullableStringField,
      kind: { enum: ["class", "subclass"] }, parentClassIds: { type: "array", items: stringField, uniqueItems: true },
      progressionColumns: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "heading"], properties: { key: stringField, heading: stringField } } },
      progressionRows: { type: "array", items: { type: "object", additionalProperties: false, required: ["level", "cells"], properties: { level: { type: "integer", minimum: 1, maximum: 20 }, cells: { type: "object", additionalProperties: stringField } } } },
      features: { type: "array", items: { type: "object", additionalProperties: false, required: ["canonicalId", "title", "body", "level", "anchor"], properties: { canonicalId: stringField, title: stringField, body: stringField, level: { type: "integer", minimum: 1, maximum: 20 }, anchor: stringField } } },
      crossLinks: { type: "array", items: stringField, uniqueItems: true },
    },
  },
  species: {
    type: "object", additionalProperties: false,
    required: ["size", "speed"],
    properties: {
      size: { enum: ["tiny", "small", "medium", "large", "huge", "gargantuan"] }, speed: { type: "integer", minimum: 1 },
      kind: { enum: ["species", "variant"] }, parentSpeciesIds: { type: "array", items: stringField, uniqueItems: true },
      traits: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "title", "body", "anchor"], properties: { key: stringField, title: stringField, body: stringField, anchor: stringField, overrides: nullableStringField } } },
      crossLinks: { type: "array", items: stringField, uniqueItems: true },
    },
  },
  background: {
    type: "object", additionalProperties: false,
    required: ["abilityScores", "skillProficiencies"],
    properties: {
      abilityScores: { type: "array", minItems: 1, items: stringField, uniqueItems: true },
      skillProficiencies: { type: "array", minItems: 1, items: stringField, uniqueItems: true },
    },
  },
  feat: {
    type: "object", additionalProperties: false,
    required: ["category", "repeatable"],
    properties: {
      category: { enum: ["origin", "general", "fighting_style", "epic_boon"] },
      prerequisiteLevel: { type: ["integer", "null"], minimum: 1, maximum: 20 },
      prerequisiteText: nullableStringField, repeatable: { type: "boolean" },
    },
  },
  glossary: {
    type: "object", additionalProperties: false,
    required: ["category", "relatedTerms"],
    properties: { category: stringField, relatedTerms: { type: "array", items: stringField, uniqueItems: true } },
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

  const rawCandidate = value as CandidateWire;
  const flat = FLAT_ENTRY_TYPES.includes(rawCandidate.entryType as FlatEntryType);
  const attributes = flat
    ? canonicalFlatAttributes(rawCandidate.entryType as FlatEntryType, rawCandidate.attributes)
    : rawCandidate.attributes;
  const citations = rawCandidate.citations.filter((citation) => !citation.fieldPath.startsWith("$.attributes.")
    || Object.hasOwn(attributes, citation.fieldPath.slice("$.attributes.".length)));
  const changed = flat && (citations.length !== rawCandidate.citations.length || JSON.stringify(attributes) !== JSON.stringify(rawCandidate.attributes));
  const candidate: CandidateWire = changed ? {
    ...rawCandidate,
    attributes,
    citations,
  } : rawCandidate;
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
  const attributePaths = candidate.entryType === "creature" && !isLegacyCreatureAttributes(candidate.attributes)
    ? creatureEvidencePaths(validateCreatureProjection(candidate.attributes))
    : Object.keys(candidate.attributes).map((key) => `$.attributes.${key}`);
  const requiredPaths = new Set([
    "$.entryType", "$.candidateKey", "$.title", "$.body",
    ...attributePaths,
  ]);
  const citedPaths = new Set<string>();
  const supportedPaths = new Set<string>();
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
    if (citationSupportsField(candidate, citation.fieldPath, citation.quote)) supportedPaths.add(citation.fieldPath);
  }
  const missing = [...requiredPaths].filter((path) => !citedPaths.has(path));
  if (missing.length > 0) throw new CandidateValidationError(`Every derived field must be cited; missing ${missing.join(", ")}.`);
  const unsupported = [...requiredPaths].filter((path) => !supportedPaths.has(path));
  if (unsupported.length > 0) {
    throw new CandidateValidationError(`Every derived field must have value-supporting evidence; unsupported ${unsupported.join(", ")}.`);
  }
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

function citationSupportsField(candidate: CandidateWire, path: string, quote: string): boolean {
  if (/(?:ignore (?:the |all )?(?:system|previous)|system message|follow (?:these|my) instructions|claim .+ and cite|return only json)/iu.test(quote)) return false;
  const value = path.startsWith("$.attributes.")
    ? valueAtAttributePath(candidate.attributes, path.slice("$.attributes.".length))
    : candidate[path.slice(2) as keyof Pick<CandidateWire, "entryType" | "candidateKey" | "title" | "body">];
  if (candidate.entryType === "creature" && path.startsWith("$.attributes.") && !isLegacyCreatureAttributes(candidate.attributes)) {
    return creatureFieldEvidenceSupports(path, value, quote);
  }
  if (value === null) {
    if (path === "$.attributes.alignment") return supportsNull(quote) || (FIELD_CONTEXT[path]?.test(quote) === true && !quote.includes(","));
    return supportsNull(quote);
  }
  const context = FIELD_CONTEXT[path];
  if (context && !context.test(quote)) return false;
  if (path === "$.candidateKey") {
    return quote.split(/\r?\n/).some((line) => evidenceKey(line) === candidate.candidateKey);
  }
  if (path === "$.entryType") return supportsEntryType(candidate.entryType, quote);
  if (path === "$.attributes.costCp") return value === null ? supportsNull(quote) : parseMoneyToCp(quote).includes(value as number);
  if (path === "$.attributes.weightLb") return value === null ? supportsNull(quote) : parseWeights(quote).includes(value as number);
  if (path === "$.attributes.challengeRating" && isRecord(value)) {
    const numerator = Number(value.numerator); const denominator = Number(value.denominator);
    return denominator > 0 && numericValues(quote).some((number) => Math.abs(number - numerator / denominator) < 0.000001);
  }
  if (typeof value === "boolean") return supportsBoolean(path, value, quote);
  if (path === "$.attributes.level" && value === 0 && /(?:cantrip|заговор)/iu.test(quote)) return true;
  if (typeof value === "number") return numericValues(quote).some((number) => Math.abs(number - value) < 0.000001);
  if (Array.isArray(value)) return scalarValues(value).every((item) => evidenceScalarSupported(path, item, quote));
  if (isRecord(value)) return scalarValues(value).every((item) => evidenceScalarSupported(path, item, quote));
  return scalarTextSupported(path, value, quote);
}

function evidenceScalarSupported(path:string,value:unknown,quote:string):boolean {
  if(typeof value==="number")return numericValues(quote).some((number)=>Math.abs(number-value)<0.000001);
  if(typeof value==="boolean")return supportsBoolean(path,value,quote)||scalarTextSupported(path,value,quote);
  if(value===null)return supportsNull(quote);
  return scalarTextSupported(path,value,quote);
}

function blockList() {
  return { type: "array", items: { type: "object", additionalProperties: false, required: ["name", "text"], properties: { name: stringField, text: stringField } } } as const;
}

function scalarValues(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (isRecord(value)) return Object.values(value).flatMap(scalarValues);
  return [value];
}

function valueAtAttributePath(attributes: Readonly<Record<string, unknown>>, path: string): unknown {
  return path.replace(/\[([0-9]+)\]/g, ".$1").split(".").reduce<unknown>((value, part) =>
    Array.isArray(value) ? value[Number(part)] : isRecord(value) ? value[part] : undefined, attributes);
}

function isLegacyCreatureAttributes(value: Readonly<Record<string, unknown>>): boolean {
  return typeof value.armorClass === "number" && typeof value.hitPoints === "number" && typeof value.speed === "string";
}

function scalarTextSupported(path: string, value: unknown, quote: string): boolean {
  const normalizedQuote = normalizeEvidence(String(quote));
  const normalizedValue = normalizeEvidence(String(value));
  if (normalizedValue && normalizedQuote.includes(normalizedValue)) return true;
  const aliases = FIELD_ALIASES[path]?.[String(value)] ?? [];
  return aliases.some((alias) => normalizedQuote.includes(normalizeEvidence(alias)));
}

function supportsEntryType(entryType: CompendiumEntryType, quote: string): boolean {
  const patterns: Readonly<Record<CompendiumEntryType, RegExp>> = {
    spell: /(?:cantrip|заговор|\b\d(?:st|nd|rd|th)?-?level\b|\b\d(?:-й|-го)? уровень\b|casting time|время (?:накладывания|сотворения)|abjuration|conjuration|divination|enchantment|evocation|illusion|necromancy|transmutation|ограждение|вызов|прорицание|очарование|воплощение|иллюзия|некромантия|преобразование)/iu,
    creature: /(?:armor class|hit points|challenge|класс доспеха|хиты|опасность|tiny|small|medium|large|huge|gargantuan|крошечн|маленьк|средн|больш|огромн|громадн)/iu,
    equipment: /(?:equipment|gear|cost|weight|снаряжение|стоимость|цена|вес)/iu,
    feature: /(?:feature|умение)/iu,
    item: /(?:item|предмет|rarity|редкост)/iu,
    class: /(?:class|класс|hit die|кость хитов)/iu,
    species: /(?:species|вид|раса)/iu,
    background: /(?:background|предыстори)/iu,
    feat: /(?:feat|черта)/iu,
    glossary: /(?:glossary|term|словар|термин)/iu,
  };
  return patterns[entryType].test(quote);
}

function supportsBoolean(path: string, value: boolean, quote: string): boolean {
  const normalized = normalizeEvidence(quote);
  if (path === "$.attributes.ritual") return value
    ? /\b(?:ritual|ритуал)/u.test(normalized)
    : supportsEntryType("spell", quote) && !/\b(?:ritual|ритуал)/u.test(normalized);
  if (path === "$.attributes.concentration") return value
    ? /(?:concentration|концентрац)/u.test(normalized)
    : /(?:duration|длительность)/u.test(normalized) && !/(?:concentration|концентрац)/u.test(normalized);
  const truthy = /(?:\byes\b|\btrue\b|да|требует|repeatable|повторяем)/u.test(normalized);
  const falsy = /(?:\bno\b|\bfalse\b|нет|не требует|not repeatable|неповторяем)/u.test(normalized);
  return value ? truthy : falsy;
}

function supportsNull(quote: string): boolean {
  return /(?:^|\s)(?:-|—|none|null|нет|отсутствует)(?:$|\s)/iu.test(quote.trim());
}

function normalizeEvidence(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}/]+/gu, " ").trim();
}

function evidenceKey(value: string): string {
  const cyrillic: Readonly<Record<string, string>> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m",
    н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "kh", ц: "ts", ч: "ch", ш: "sh", щ: "shch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  return value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase("und")
    .replace(/[а-яё]/g, (letter) => cyrillic[letter] ?? "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 128).replace(/-+$/g, "");
}

function numericValues(value: string): number[] {
  const values: number[] = [];
  for (const match of value.matchAll(/(?<![\d/])(-?\d+)\s*\/\s*(\d+)(?![\d/])/g)) {
    const denominator = Number(match[2]);
    if (denominator !== 0) values.push(Number(match[1]) / denominator);
  }
  for (const match of value.matchAll(/(?<![\d/])-?\d+(?:[.,]\d+)?(?![\d/])/g)) {
    values.push(Number(match[0].replace(",", ".")));
  }
  return values;
}

export function parseMoneyToCp(value: string): number[] {
  const values: number[] = [];
  const pattern = /((?:\d{1,3}(?:[ ,]\d{3})+|\d+)(?:[.,]\d+)?|\d+\s*\/\s*\d+)\s*(cp|sp|gp|pp|мм|см|зм|пм)(?!\p{L})/giu;
  for (const match of value.matchAll(pattern)) {
    const amount = parseNumber(match[1]);
    const multiplier: Readonly<Record<string, number>> = { cp: 1, мм: 1, sp: 10, см: 10, gp: 100, зм: 100, pp: 1000, пм: 1000 };
    const cp = amount * multiplier[match[2].toLocaleLowerCase("und")];
    if (Number.isSafeInteger(cp) && cp >= 0) values.push(cp);
  }
  return values;
}

export function parseWeights(value: string): number[] {
  const values: number[] = [];
  const pattern = /(?:(\d+)\s+)?(\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?)\s*(?:lb\.?|lbs\.?|фунт(?:а|ов)?|фт\.?)/giu;
  for (const match of value.matchAll(pattern)) {
    values.push((match[1] ? Number(match[1]) : 0) + parseNumber(match[2]));
  }
  return values;
}

function parseNumber(value: string): number {
  const compact = value.trim();
  if (compact.includes("/")) {
    const [numerator, denominator] = compact.split("/").map((part) => Number(part.trim()));
    return denominator === 0 ? Number.NaN : numerator / denominator;
  }
  if (/^\d{1,3}(?:[ ,]\d{3})+(?:\.\d+)?$/.test(compact)) return Number(compact.replace(/[ ,]/g, ""));
  return Number(compact.replace(",", "."));
}

const FIELD_ALIASES: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = {
  "$.attributes.school": {
    abjuration: ["ограждение"], conjuration: ["вызов"], divination: ["прорицание"], enchantment: ["очарование"],
    evocation: ["воплощение"], illusion: ["иллюзия"], necromancy: ["некромантия"], transmutation: ["преобразование"],
  },
  "$.attributes.size": {
    tiny: ["крошечный", "крошечное", "крошечная"], small: ["маленький", "маленькое", "маленькая"],
    medium: ["средний", "среднее", "средняя"], large: ["большой", "большое", "большая"],
    huge: ["огромный", "огромное", "огромная"], gargantuan: ["громадный", "громадное", "громадная"],
  },
  "$.attributes.category": {
    adventuring_gear: ["adventuring gear", "снаряжение"], ammunition: ["ammunition", "боеприпасы"], armor: ["armor", "доспехи"],
    focus: ["focus", "фокусировка"], mount: ["mount", "верховые животные"], tool: ["tool", "инструменты"],
    vehicle: ["vehicle", "транспорт"], weapon: ["weapon", "оружие"], other: ["other", "прочее"],
  },
};

const FIELD_CONTEXT: Readonly<Record<string, RegExp>> = {
  "$.attributes.level": /(?:cantrip|заговор|level|уров|feature|умение)/iu,
  "$.attributes.castingTime": /(?:casting time|время (?:накладывания|сотворения))/iu,
  "$.attributes.range": /(?:range|дистанция|дальность)/iu,
  "$.attributes.duration": /(?:duration|длительность)/iu,
  "$.attributes.components": /(?:components|компоненты)/iu,
  "$.attributes.concentration": /(?:duration|длительность|concentration|концентрац)/iu,
  "$.attributes.ritual": /(?:cantrip|заговор|level|уров|ritual|ритуал|abjuration|conjuration|divination|enchantment|evocation|illusion|necromancy|transmutation|ограждение|вызов|прорицание|очарование|воплощение|иллюзия|некромантия|преобразование)/iu,
  "$.attributes.creatureType": /(?:tiny|small|medium|large|huge|gargantuan|крошечн|маленьк|средн|больш|огромн|громадн)/iu,
  "$.attributes.alignment": /(?:tiny|small|medium|large|huge|gargantuan|крошечн|маленьк|средн|больш|огромн|громадн)/iu,
  "$.attributes.armorClass": /(?:armor class|класс доспеха)/iu,
  "$.attributes.hitPoints": /(?:hit points|хиты)/iu,
  "$.attributes.challengeRating": /(?:challenge|опасность|показатель опасности)/iu,
  "$.attributes.speed": /(?:speed|скорость)/iu,
  "$.attributes.costCp": /(?:cp|sp|gp|pp|мм|см|зм|пм)(?!\p{L})/iu,
  "$.attributes.weightLb": /(?:lb\.?|lbs\.?|фунт|фт\.?)/iu,
  "$.attributes.hitDie": /(?:hit die|кость хитов)/iu,
  "$.attributes.primaryAbility": /(?:primary ability|основная характеристика)/iu,
  "$.attributes.spellcastingAbility": /(?:spellcasting ability|заклинательная характеристика)/iu,
  "$.attributes.abilityScores": /(?:ability scores?|характеристик)/iu,
  "$.attributes.skillProficiencies": /(?:skill proficien|владение навыками)/iu,
  "$.attributes.prerequisiteLevel": /(?:prerequisite|требование|уров)/iu,
  "$.attributes.prerequisiteText": /(?:prerequisite|требование)/iu,
  "$.attributes.repeatable": /(?:repeatable|повторяем|неповторяем|yes|no|да|нет)/iu,
  "$.attributes.requiresAttunement": /(?:attunement|настройк|yes|no|да|нет)/iu,
};
