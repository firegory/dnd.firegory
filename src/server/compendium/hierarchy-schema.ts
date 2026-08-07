export type ProgressionColumn = Readonly<{ key: string; heading: string }>;
export type ProgressionRow = Readonly<{ level: number; cells: Readonly<Record<string, string>> }>;
export type ClassFeatureLink = Readonly<{ canonicalId: string; title: string; body: string; level: number; anchor: string }>;
export type SpeciesTrait = Readonly<{ key: string; title: string; body: string; anchor: string; overrides?: string | null }>;

export type ClassProjection = Readonly<{
  kind: "class" | "subclass";
  hitDie: 6 | 8 | 10 | 12;
  primaryAbility: string;
  spellcastingAbility: string | null;
  parentClassIds: readonly string[];
  progressionColumns: readonly ProgressionColumn[];
  progressionRows: readonly ProgressionRow[];
  features: readonly ClassFeatureLink[];
  crossLinks: readonly string[];
}>;

export type SpeciesProjection = Readonly<{
  kind: "species" | "variant";
  size: "tiny" | "small" | "medium" | "large" | "huge" | "gargantuan";
  speed: number;
  parentSpeciesIds: readonly string[];
  traits: readonly SpeciesTrait[];
  crossLinks: readonly string[];
}>;

export class HierarchyValidationError extends Error {}

const STABLE = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const CANONICAL = /^(?:spell|creature|item|class|feature|species|background|feat|equipment)-[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/;
const RESERVED_ANCHOR = /^(?:progression|level-(?:[1-9]|1[0-9]|20)|section(?:-|$))/;

export function validateClassProjection(value: unknown, options: Readonly<{ requireCompleteBase?: boolean }> = {}): ClassProjection {
  if (!record(value)) fail("Class projection must be an object.");
  const kind = value.kind ?? "class";
  if (kind !== "class" && kind !== "subclass") fail("Class kind must be class or subclass.");
  if (![6, 8, 10, 12].includes(Number(value.hitDie))) fail("Class hitDie must be d6, d8, d10, or d12.");
  const primaryAbility = text(value.primaryAbility, "primaryAbility");
  const spellcastingAbility = value.spellcastingAbility == null ? null : text(value.spellcastingAbility, "spellcastingAbility");
  const parentClassIds = stableList(value.parentClassIds ?? [], "parentClassIds", "class-");
  if (kind === "class" && parentClassIds.length) fail("A base class cannot have parent classes.");
  if (kind === "subclass" && !parentClassIds.length) fail("A subclass requires at least one parent class.");
  const progressionColumns = objectList(value.progressionColumns ?? [], "progressionColumns").map((column, index) => ({
    key: stable(column.key, `progressionColumns[${index}].key`), heading: text(column.heading, `progressionColumns[${index}].heading`),
  }));
  unique(progressionColumns.map(({ key }) => key), "progression column keys");
  const columnKeys = new Set(progressionColumns.map(({ key }) => key));
  const progressionRows = objectList(value.progressionRows ?? [], "progressionRows").map((row, index) => {
    const level = integer(row.level, 1, 20, `progressionRows[${index}].level`);
    if (!record(row.cells) || Object.keys(row.cells).length !== columnKeys.size || Object.keys(row.cells).some((key) => !columnKeys.has(key))) {
      fail(`Progression level ${level} must have exactly one cell for every column.`);
    }
    const cells = row.cells as Record<string, unknown>;
    return { level, cells: Object.fromEntries(progressionColumns.map(({ key }) => [key, text(cells[key], `progressionRows[${index}].cells.${key}`)])) };
  });
  unique(progressionRows.map(({ level }) => String(level)), "progression levels");
  if (progressionRows.length > 0 && progressionColumns.length === 0) fail("A progression requires at least one column.");
  if (kind === "class" && (options.requireCompleteBase ?? true) && (progressionRows.length !== 20 || progressionRows.some((row, index) => row.level !== index + 1))) {
    fail("A base class progression must contain ordered levels 1 through 20 exactly once.");
  }
  const features = objectList(value.features ?? [], "features").map((feature, index) => ({
    canonicalId: canonical(feature.canonicalId, `features[${index}].canonicalId`, "feature-"),
    title: text(feature.title, `features[${index}].title`), body: text(feature.body, `features[${index}].body`), level: integer(feature.level, 1, 20, `features[${index}].level`),
    anchor: anchor(feature.anchor, `features[${index}].anchor`),
  }));
  unique(features.map(({ canonicalId }) => canonicalId), "class feature IDs");
  unique(features.map(({ anchor }) => anchor), "class feature anchors");
  return { kind, hitDie: Number(value.hitDie) as 6 | 8 | 10 | 12, primaryAbility, spellcastingAbility,
    parentClassIds, progressionColumns, progressionRows, features, crossLinks: stableList(value.crossLinks ?? [], "crossLinks") };
}

export function validateSpeciesProjection(value: unknown): SpeciesProjection {
  if (!record(value)) fail("Species projection must be an object.");
  const kind = value.kind ?? "species";
  if (kind !== "species" && kind !== "variant") fail("Species kind must be species or variant.");
  const sizes = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
  if (typeof value.size !== "string" || !sizes.includes(value.size as typeof sizes[number])) fail("Species size is unsupported.");
  const parentSpeciesIds = stableList(value.parentSpeciesIds ?? [], "parentSpeciesIds", "species-");
  if (kind === "species" && parentSpeciesIds.length) fail("A base species cannot have parent species.");
  if (kind === "variant" && !parentSpeciesIds.length) fail("A species variant requires at least one parent species.");
  const traits = objectList(value.traits ?? [], "traits").map((trait, index) => ({
    key: stable(trait.key, `traits[${index}].key`), title: text(trait.title, `traits[${index}].title`),
    body: text(trait.body, `traits[${index}].body`), anchor: anchor(trait.anchor, `traits[${index}].anchor`),
    overrides: trait.overrides == null ? null : stable(trait.overrides, `traits[${index}].overrides`),
  }));
  unique(traits.map(({ key }) => key), "species trait keys"); unique(traits.map(({ anchor }) => anchor), "species trait anchors");
  return { kind, size: value.size as SpeciesProjection["size"], speed: integer(value.speed, 1, 2147483647, "speed"),
    parentSpeciesIds, traits, crossLinks: stableList(value.crossLinks ?? [], "crossLinks") };
}

export function hierarchyTypedValue(key: string, value: unknown): unknown {
  return ["progressionColumns", "progressionRows", "features", "traits"].includes(key)
    && Array.isArray(value) && value.some((item) => typeof item === "object")
    ? value.map((item) => JSON.stringify(item)) : value;
}

export function classProjectionFromTypedFields(fields: unknown): ClassProjection { return validateClassProjection(typedObject(fields)); }
export function speciesProjectionFromTypedFields(fields: unknown): SpeciesProjection { return validateSpeciesProjection(typedObject(fields)); }

function typedObject(fields: unknown): Record<string, unknown> {
  if (!Array.isArray(fields)) fail("Canonical hierarchy typedFields must be an array.");
  const result: Record<string, unknown> = {};
  for (const field of fields) if (record(field) && typeof field.key === "string") {
    const key = field.key.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    result[key] = ["progressionColumns", "progressionRows", "features", "traits"].includes(key) && Array.isArray(field.value)
      ? field.value.map((item) => { try { return JSON.parse(String(item)); } catch { fail(`Canonical ${key} contains malformed JSON.`); } })
      : field.value;
  }
  result.parentClassIds ??= []; result.parentSpeciesIds ??= []; result.progressionColumns ??= []; result.progressionRows ??= [];
  result.features ??= []; result.traits ??= []; result.crossLinks ??= [];
  return result;
}

function stableList(value: unknown, field: string, prefix?: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) fail(`${field} must be a string list.`);
  const items = value.map((item) => item.normalize("NFC").trim());
  if (items.some((item) => prefix ? !item.startsWith(prefix) || !CANONICAL.test(item) : !CANONICAL.test(item))) fail(`${field} contains an invalid canonical ID.`);
  unique(items, field); return items;
}
function objectList(value: unknown, field: string): Record<string, unknown>[] { if (!Array.isArray(value) || value.some((item) => !record(item))) fail(`${field} must be an object list.`); return value as Record<string, unknown>[]; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function text(value: unknown, field: string): string { if (typeof value !== "string" || !value.trim()) fail(`${field} is required.`); return value.normalize("NFC").trim(); }
function stable(value: unknown, field: string): string { const result = text(value, field); if (!STABLE.test(result)) fail(`${field} must be a stable lowercase ID.`); return result; }
function anchor(value: unknown, field: string): string { const result = stable(value, field); if (RESERVED_ANCHOR.test(result)) fail(`${field} uses a reserved page anchor.`); return result; }
function canonical(value: unknown, field: string, prefix: string): string { const result = text(value, field); if (!result.startsWith(prefix) || !CANONICAL.test(result)) fail(`${field} is invalid.`); return result; }
function integer(value: unknown, min: number, max: number, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(`${field} must be an integer from ${min} to ${max}.`); return Number(value); }
function unique(values: readonly string[], field: string): void { if (new Set(values).size !== values.length) fail(`${field} must be unique.`); }
function fail(message: string): never { throw new HierarchyValidationError(message); }
