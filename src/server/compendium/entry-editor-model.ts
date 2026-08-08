import {
  COMPENDIUM_ENTRY_TYPES,
  CompendiumValidationError,
  validateDraft,
  type CitationInput,
  type CompendiumEdition,
  type CompendiumEntryType,
  type CompendiumLanguage,
  type CreateCompendiumDraftInput,
  type ProjectionInput,
} from "./service.ts";
import { normalizeSpellClasses } from "./spell-schema.ts";
import { validateCreatureProjection } from "./creature-schema.ts";

export type EditorBlock =
  | Readonly<{ type: "heading" | "paragraph"; text: string }>
  | Readonly<{ type: "list"; items: readonly string[] }>;

export type EditorEntryInput = Readonly<{
  canonicalKey: string;
  entryType: CompendiumEntryType;
  edition: CompendiumEdition;
  language: CompendiumLanguage;
  sourceId: string;
  fileId: string;
  slug: string;
  aliases: readonly string[];
  title: string;
  summary: string | null;
  blocks: readonly EditorBlock[];
  projection: ProjectionInput;
  citations: readonly CitationInput[];
  reason: string;
}>;

export type EditorCorrectionInput = Pick<EditorEntryInput, "title" | "summary" | "blocks" | "projection" | "citations" | "reason"> & Readonly<{
  basedOnRevisionId: string;
}>;

const ROOT_KEYS = ["aliases", "blocks", "canonicalKey", "citations", "edition", "entryType", "fileId", "language", "projection", "reason", "slug", "sourceId", "summary", "title"];
const CORRECTION_KEYS = ["basedOnRevisionId", "blocks", "citations", "projection", "reason", "summary", "title"];
const PROJECTION_KEYS: Readonly<Record<CompendiumEntryType, readonly string[]>> = {
  spell: ["castingTime", "classes", "components", "concentration", "duration", "level", "range", "ritual", "school", "type"],
  creature: ["abilities", "actions", "alignment", "armorClass", "bonusActions", "challengeRating", "conditionImmunities", "creatureType", "damageImmunities", "damageResistances", "hitPoints", "languages", "legendaryActions", "passivePerception", "reactions", "saves", "senses", "size", "skills", "speeds", "traits", "type"],
  item: ["category", "rarity", "requiresAttunement", "type"],
  class: ["crossLinks", "features", "hitDie", "kind", "parentClassIds", "primaryAbility", "progressionColumns", "progressionRows", "spellcastingAbility", "type"],
  feature: ["featureKind", "level", "type"],
  species: ["crossLinks", "kind", "parentSpeciesIds", "size", "speed", "traits", "type"],
  background: ["abilityScores", "skillProficiencies", "type"],
  feat: ["category", "prerequisiteLevel", "prerequisiteText", "repeatable", "type"],
  equipment: ["category", "costCp", "type", "weightLb"],
  glossary: ["category", "relatedTerms", "type"],
};
const CITATION_KEYS = ["blockOrder", "chunkId", "fieldPath", "generationId", "kind", "quote", "quoteSpanEnd", "quoteSpanStart"];

export function parseEditorEntryInput(value: unknown): EditorEntryInput {
  const input = objectWithKeys(value, ROOT_KEYS, "entry");
  if (typeof input.entryType !== "string" || !COMPENDIUM_ENTRY_TYPES.includes(input.entryType as CompendiumEntryType)) fail("Unsupported entry type.");
  const entryType = input.entryType as CompendiumEntryType;
  const parsed = {
    canonicalKey: string(input.canonicalKey, "canonicalKey"), entryType,
    edition: enumText(input.edition, ["5e", "5.5e"], "edition") as CompendiumEdition,
    language: enumText(input.language, ["en", "ru"], "language") as CompendiumLanguage,
    sourceId: string(input.sourceId, "sourceId"), fileId: string(input.fileId, "fileId"),
    slug: boundedText(input.slug, "slug", 128), aliases: stringArray(input.aliases, "aliases").map((alias, index) => safeBlockText(alias, `aliases[${index}]`, 200)),
    title: safeBlockText(input.title, "title", 500), summary: nullableSafeText(input.summary, "summary", 2_000),
    blocks: parseBlocks(input.blocks), projection: parseProjection(input.projection, entryType),
    citations: parseCitations(input.citations), reason: requiredReason(input.reason),
  } satisfies EditorEntryInput;
  validateDraft(asDraft(parsed));
  return parsed;
}

export function parseEditorCorrectionInput(value: unknown, entryType: CompendiumEntryType): EditorCorrectionInput {
  const input = objectWithKeys(value, CORRECTION_KEYS, "correction");
  const parsed = {
    basedOnRevisionId: string(input.basedOnRevisionId, "basedOnRevisionId"),
    title: safeBlockText(input.title, "title", 500), summary: nullableSafeText(input.summary, "summary", 2_000),
    blocks: parseBlocks(input.blocks), projection: parseProjection(input.projection, entryType),
    citations: parseCitations(input.citations), reason: requiredReason(input.reason),
  } satisfies EditorCorrectionInput;
  validateDraft({
    canonicalKey: "validation", entryType, edition: "5e", language: "en",
    sourceId: "00000000-0000-4000-8000-000000000000", fileId: "00000000-0000-4000-8000-000000000001",
    slug: "validation", title: parsed.title, summary: parsed.summary, projection: parsed.projection, citations: parsed.citations,
    body: blocksToBody(parsed.blocks), extensionData: editorExtension(parsed.blocks),
  });
  return parsed;
}

export function blocksToBody(blocks: readonly EditorBlock[]): string {
  if (!Array.isArray(blocks) || blocks.length < 1 || blocks.length > 100) fail("blocks must contain between 1 and 100 structured blocks.");
  return blocks.map((block) => block.type === "list" ? block.items.map((item: string) => `- ${item}`).join("\n") : block.text).join("\n\n");
}

export function editorExtension(blocks: readonly EditorBlock[]): Readonly<Record<string, unknown>> {
  return { editor: { schemaVersion: 1, blocks } };
}

function asDraft(input: EditorEntryInput): CreateCompendiumDraftInput {
  return {
    canonicalKey: input.canonicalKey, entryType: input.entryType, edition: input.edition, language: input.language,
    sourceId: input.sourceId, fileId: input.fileId, slug: input.slug, aliases: input.aliases,
    title: input.title, summary: input.summary, body: blocksToBody(input.blocks), extensionData: editorExtension(input.blocks),
    projection: input.projection, citations: input.citations,
  };
}

function parseBlocks(value: unknown): readonly EditorBlock[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail("blocks must contain between 1 and 100 structured blocks.");
  return value.map((item, index) => {
    if (!isRecord(item) || typeof item.type !== "string") fail(`blocks[${index}] is invalid.`);
    if (item.type === "heading" || item.type === "paragraph") {
      exactKeys(item, ["text", "type"], `blocks[${index}]`);
      return { type: item.type, text: safeBlockText(item.text, `blocks[${index}].text`, 20_000) };
    }
    if (item.type === "list") {
      exactKeys(item, ["items", "type"], `blocks[${index}]`);
      const items = stringArray(item.items, `blocks[${index}].items`);
      if (items.length < 1 || items.length > 100) fail(`blocks[${index}].items must contain between 1 and 100 items.`);
      return { type: "list", items: items.map((text, itemIndex) => safeBlockText(text, `blocks[${index}].items[${itemIndex}]`, 2_000)) };
    }
    fail(`blocks[${index}].type is unsupported.`);
  });
}

function parseProjection(value: unknown, entryType: CompendiumEntryType): ProjectionInput {
  const projection = objectWithKeys(value, PROJECTION_KEYS[entryType], "projection");
  if (projection.type !== entryType) fail("Projection type must match entry type.");
  for (const [key, item] of Object.entries(projection)) {
    if (typeof item === "string" && /<\s*\/?\s*[a-z][^>]*>/i.test(item)) fail(`projection.${key} cannot contain HTML markup.`);
  }
  if (entryType === "spell") {
    try { return { ...projection, classes: normalizeSpellClasses(projection.classes) } as ProjectionInput; }
    catch (error) { if (error instanceof Error) fail(error.message); throw error; }
  }
  if (entryType === "creature") {
    const value = { ...projection }; delete value.type;
    try { return { type: "creature", ...validateCreatureProjection(value) } as ProjectionInput; }
    catch (error) { if (error instanceof Error) fail(error.message); throw error; }
  }
  return projection as ProjectionInput;
}

function parseCitations(value: unknown): readonly CitationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) fail("At least one and at most 100 citations are required.");
  return value.map((item, index) => objectWithKeys(item, CITATION_KEYS, `citations[${index}]`) as CitationInput);
}

function objectWithKeys(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!isRecord(value)) fail(`${field} must be an object.`);
  exactKeys(value, keys, field);
  return value;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) fail(`${field} contains unsupported fields.`);
}
function string(value: unknown, field: string): string { if (typeof value !== "string") fail(`${field} must be text.`); return value; }
function boundedText(value: unknown, field: string, max: number): string { const result = string(value, field).trim(); if (!result || result.length > max) fail(`${field} must contain 1 to ${max} characters.`); return result; }
function safeBlockText(value: unknown, field: string, max: number): string { const result = boundedText(value, field, max); if (/<\s*\/?\s*[a-z][^>]*>/i.test(result)) fail(`${field} cannot contain HTML markup.`); return result; }
function nullableSafeText(value: unknown, field: string, max: number): string | null { if (value === null || value === "") return null; return safeBlockText(value, field, max); }
function stringArray(value: unknown, field: string): string[] { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${field} must be a text array.`); return value as string[]; }
function enumText(value: unknown, allowed: readonly string[], field: string): string { const result = string(value, field); if (!allowed.includes(result)) fail(`${field} is unsupported.`); return result; }
function requiredReason(value: unknown): string { return boundedText(value, "reason", 1_000); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(message: string): never { throw new CompendiumValidationError(message); }
