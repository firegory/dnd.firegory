export const FLAT_ENTRY_TYPES = ["feat", "background", "item", "equipment", "glossary"] as const;
export type FlatEntryType = (typeof FLAT_ENTRY_TYPES)[number];
export function flatCollection(type: FlatEntryType): string { return type === "equipment" || type === "glossary" ? type : `${type}s`; }
export function compendiumEntryRoute(type: string, id: string, language: "ru" | "en"): string {
  const collections: Readonly<Record<string, string>> = {
    spell: "spells", feat: "feats", background: "backgrounds", item: "items", equipment: "equipment", glossary: "glossary",
  };
  return collections[type] ? `/${collections[type]}/${id}` : `/${language}/compendium/entries/${id}`;
}

export const FEAT_CATEGORIES = ["origin", "general", "fighting_style", "epic_boon"] as const;
export const ITEM_CATEGORIES = ["armor", "potion", "ring", "rod", "scroll", "staff", "wand", "weapon", "wondrous", "other"] as const;
export const ITEM_RARITIES = ["common", "uncommon", "rare", "very_rare", "legendary", "artifact", "varies"] as const;
export const EQUIPMENT_CATEGORIES = ["adventuring_gear", "ammunition", "armor", "focus", "mount", "tool", "vehicle", "weapon", "other"] as const;

export type FlatProjection =
  | Readonly<{ type: "feat"; category: (typeof FEAT_CATEGORIES)[number]; prerequisiteLevel: number | null; prerequisiteText: string | null; repeatable: boolean }>
  | Readonly<{ type: "background"; abilityScores: string; skillProficiencies: string }>
  | Readonly<{ type: "item"; category: (typeof ITEM_CATEGORIES)[number]; rarity: (typeof ITEM_RARITIES)[number]; requiresAttunement: boolean }>
  | Readonly<{ type: "equipment"; category: (typeof EQUIPMENT_CATEGORIES)[number]; costCp: number | null; weightLb: number | null }>
  | Readonly<{ type: "glossary"; category: string; relatedTerms: readonly string[] }>;

export class FlatValidationError extends Error {
  constructor(message: string) { super(message); this.name = "FlatValidationError"; }
}

export function validateFlatProjection(type: FlatEntryType, value: unknown): FlatProjection {
  if (!isRecord(value)) throw new FlatValidationError(`${type} projection must be an object.`);
  switch (type) {
    case "feat": {
      const category = enumValue(value.category, FEAT_CATEGORIES, "feat category");
      const prerequisiteLevel = nullableInteger(value.prerequisiteLevel ?? null, 1, 20, "feat prerequisite level");
      const prerequisiteText = nullableText(value.prerequisiteText ?? null, "feat prerequisite text");
      if (typeof value.repeatable !== "boolean") throw new FlatValidationError("Feat repeatable must be boolean.");
      return { type, category, prerequisiteLevel, prerequisiteText, repeatable: value.repeatable };
    }
    case "background":
      return { type, abilityScores: text(value.abilityScores, "background ability scores"), skillProficiencies: text(value.skillProficiencies, "background skill proficiencies") };
    case "item": {
      const category = enumValue(value.category, ITEM_CATEGORIES, "item category");
      const rarity = enumValue(value.rarity, ITEM_RARITIES, "item rarity");
      if (typeof value.requiresAttunement !== "boolean") throw new FlatValidationError("Item requiresAttunement must be boolean.");
      return { type, category, rarity, requiresAttunement: value.requiresAttunement };
    }
    case "equipment":
      return {
        type, category: enumValue(value.category, EQUIPMENT_CATEGORIES, "equipment category"),
        costCp: nullableInteger(value.costCp ?? null, 0, 2_147_483_647, "equipment cost"),
        weightLb: nullableNumber(value.weightLb ?? null, 0, 9_999_999.999, "equipment weight"),
      };
    case "glossary": {
      if (!Array.isArray(value.relatedTerms) || value.relatedTerms.some((item) => typeof item !== "string" || !item.trim())) {
        throw new FlatValidationError("Glossary relatedTerms must be a text list.");
      }
      return { type, category: text(value.category, "glossary category"), relatedTerms: [...new Set(value.relatedTerms.map((item) => item.normalize("NFC").trim()))] };
    }
  }
}

export function flatProjectionFromTypedFields(type: FlatEntryType, fields: unknown): FlatProjection {
  if (!Array.isArray(fields)) throw new FlatValidationError(`Canonical ${type} typedFields must be an array.`);
  const values: Record<string, unknown> = {};
  for (const field of fields) if (isRecord(field) && typeof field.key === "string") values[toCamelCase(field.key)] = field.value;
  if (type === "feat") { values.prerequisiteLevel ??= null; values.prerequisiteText ??= null; values.repeatable ??= false; }
  if (type === "item") values.requiresAttunement ??= false;
  if (type === "equipment") { values.costCp ??= null; values.weightLb ??= null; }
  if (type === "glossary") values.relatedTerms ??= [];
  return validateFlatProjection(type, values);
}

export function projectionAttributes(projection: FlatProjection): Readonly<Record<string, unknown>> {
  return Object.fromEntries(Object.entries(projection).filter(([key, value]) => key !== "type" && value !== null));
}

export function canonicalFlatAttributes(type: FlatEntryType, value: unknown): Readonly<Record<string, unknown>> {
  return projectionAttributes(validateFlatProjection(type, value));
}

function enumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) throw new FlatValidationError(`${field} is unsupported.`);
  return value as T[number];
}
function text(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) throw new FlatValidationError(`${field} is required.`); return value.normalize("NFC").trim(); }
function nullableText(value: unknown, field: string): string | null { return value === null ? null : text(value, field); }
function nullableInteger(value: unknown, min: number, max: number, field: string): number | null { if (value === null) return null; if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new FlatValidationError(`${field} is invalid.`); return Number(value); }
function nullableNumber(value: unknown, min: number, max: number, field: string): number | null { if (value === null) return null; if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new FlatValidationError(`${field} is invalid.`); return value; }
function toCamelCase(value: string): string { return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
