export const CREATURE_SIZES = ["tiny", "small", "medium", "large", "huge", "gargantuan"] as const;
export const MOVEMENT_MODES = ["walk", "burrow", "climb", "fly", "swim"] as const;
export const ABILITY_KEYS = ["str", "dex", "con", "int", "wis", "cha"] as const;
export const CREATURE_BLOCK_SECTIONS = ["traits", "actions", "bonusActions", "reactions", "legendaryActions"] as const;

export type CreatureSize = (typeof CREATURE_SIZES)[number];
export type ChallengeRating = Readonly<{ numerator: number; denominator: number }>;
export type CreatureBlock = Readonly<{ name: string; text: string }>;
export type LegacyCreatureProjection = Readonly<{
  size: CreatureSize;
  creatureType: string;
  alignment: string | null;
  armorClass: number;
  hitPoints: number;
  challengeRating: ChallengeRating;
  speed: string;
}>;
export type CreatureProjection = Readonly<{
  size: CreatureSize;
  creatureType: string;
  alignment: string | null;
  challengeRating: ChallengeRating;
  armorClass: readonly Readonly<{ value: number; note?: string }>[];
  hitPoints: Readonly<{ average: number; formula?: string }>;
  speeds: readonly Readonly<{ mode: (typeof MOVEMENT_MODES)[number]; distance: number; unit: "ft" | "m"; note?: string }>[];
  abilities: Readonly<Record<(typeof ABILITY_KEYS)[number], number>>;
  saves: Readonly<Record<string, number>>;
  skills: Readonly<Record<string, number>>;
  damageResistances: readonly string[];
  damageImmunities: readonly string[];
  conditionImmunities: readonly string[];
  senses: readonly string[];
  passivePerception: number;
  languages: readonly string[];
  traits: readonly CreatureBlock[];
  actions: readonly CreatureBlock[];
  bonusActions: readonly CreatureBlock[];
  reactions: readonly CreatureBlock[];
  legendaryActions: readonly CreatureBlock[];
}>;

export class CreatureValidationError extends Error {
  constructor(message: string) { super(message); this.name = "CreatureValidationError"; }
}

const CR_VALUES = new Set(["0/1", "1/8", "1/4", "1/2", ...Array.from({ length: 30 }, (_, index) => `${index + 1}/1`)]);
const FORMULA = /^\d+d\d+(?:\s*[+-]\s*\d+)?$/i;

export function normalizeChallengeRating(value: unknown): ChallengeRating {
  let numerator: number;
  let denominator: number;
  if (typeof value === "number") {
    const known: Readonly<Record<string, ChallengeRating>> = {
      "0": { numerator: 0, denominator: 1 }, "0.125": { numerator: 1, denominator: 8 },
      "0.25": { numerator: 1, denominator: 4 }, "0.5": { numerator: 1, denominator: 2 },
    };
    const rational = known[String(value)] ?? (Number.isSafeInteger(value) ? { numerator: value, denominator: 1 } : null);
    if (!rational) throw new CreatureValidationError("challengeRating is unsupported.");
    return validateChallengeRating(rational);
  }
  if (typeof value === "string") {
    const match = value.trim().match(/^(\d+)(?:\s*\/\s*(\d+))?$/);
    if (!match) throw new CreatureValidationError("challengeRating must be an exact integer or fraction.");
    numerator = Number(match[1]); denominator = Number(match[2] ?? 1);
  } else if (isRecord(value)) {
    exactKeys(value, ["denominator", "numerator"], "challengeRating");
    numerator = Number(value.numerator); denominator = Number(value.denominator);
  } else throw new CreatureValidationError("challengeRating must be an exact integer or fraction.");
  return validateChallengeRating({ numerator, denominator });
}

export function challengeRatingNumber(value: ChallengeRating): number { return value.numerator / value.denominator; }
export function formatChallengeRating(value: ChallengeRating): string { return value.denominator === 1 ? String(value.numerator) : `${value.numerator}/${value.denominator}`; }

export function validateCreatureProjection(value: unknown): CreatureProjection {
  if (!isRecord(value)) throw new CreatureValidationError("Creature projection must be an object.");
  exactKeys(value, ["abilities", "actions", "alignment", "armorClass", "bonusActions", "challengeRating", "conditionImmunities", "creatureType", "damageImmunities", "damageResistances", "hitPoints", "languages", "legendaryActions", "passivePerception", "reactions", "saves", "senses", "size", "skills", "speeds", "traits"], "creature");
  if (typeof value.size !== "string" || !CREATURE_SIZES.includes(value.size as CreatureSize)) fail("Creature size is unsupported.");
  const creatureType = text(value.creatureType, "creatureType", 160);
  const alignment = value.alignment === null ? null : text(value.alignment, "alignment", 160);
  const challengeRating = normalizeChallengeRating(value.challengeRating);
  const armorClass = array(value.armorClass, "armorClass", 1, 8).map((item, index) => {
    const row = object(item, `armorClass[${index}]`); exactKeys(row, row.note === undefined ? ["value"] : ["note", "value"], `armorClass[${index}]`);
    return { value: integer(row.value, 1, 50, `armorClass[${index}].value`), ...(row.note === undefined ? {} : { note: text(row.note, `armorClass[${index}].note`, 200) }) };
  });
  const hp = object(value.hitPoints, "hitPoints"); exactKeys(hp, hp.formula === undefined ? ["average"] : ["average", "formula"], "hitPoints");
  const hitPoints = { average: integer(hp.average, 1, 2147483647, "hitPoints.average"), ...(hp.formula === undefined ? {} : { formula: text(hp.formula, "hitPoints.formula", 40) }) };
  if (hitPoints.formula && !FORMULA.test(hitPoints.formula)) fail("hitPoints.formula must use dice notation such as 12d10 + 24.");
  const modes = new Set<string>();
  const speeds = array(value.speeds, "speeds", 1, 8).map((item, index) => {
    const row = object(item, `speeds[${index}]`); exactKeys(row, row.note === undefined ? ["distance", "mode", "unit"] : ["distance", "mode", "note", "unit"], `speeds[${index}]`);
    if (typeof row.mode !== "string" || !MOVEMENT_MODES.includes(row.mode as never) || modes.has(row.mode)) fail("Creature movement modes must be unique and supported.");
    modes.add(row.mode);
    if (row.unit !== "ft" && row.unit !== "m") fail("Creature speed unit must be ft or m.");
    return { mode: row.mode as (typeof MOVEMENT_MODES)[number], distance: integer(row.distance, 1, 10000, `speeds[${index}].distance`), unit: row.unit as "ft" | "m", ...(row.note === undefined ? {} : { note: text(row.note, `speeds[${index}].note`, 200) }) };
  });
  const abilityInput = object(value.abilities, "abilities"); exactKeys(abilityInput, ABILITY_KEYS, "abilities");
  const abilities = Object.fromEntries(ABILITY_KEYS.map((key) => [key, integer(abilityInput[key], 1, 30, `abilities.${key}`)])) as CreatureProjection["abilities"];
  return {
    size: value.size as CreatureSize, creatureType, alignment, challengeRating, armorClass, hitPoints, speeds, abilities,
    saves: modifierMap(value.saves, "saves"), skills: modifierMap(value.skills, "skills"),
    damageResistances: textList(value.damageResistances, "damageResistances"), damageImmunities: textList(value.damageImmunities, "damageImmunities"),
    conditionImmunities: textList(value.conditionImmunities, "conditionImmunities"), senses: textList(value.senses, "senses"),
    passivePerception: integer(value.passivePerception, 0, 100, "passivePerception"), languages: textList(value.languages, "languages"),
    traits: blocks(value.traits, "traits"), actions: blocks(value.actions, "actions"), bonusActions: blocks(value.bonusActions, "bonusActions"),
    reactions: blocks(value.reactions, "reactions"), legendaryActions: blocks(value.legendaryActions, "legendaryActions"),
  };
}

export function isLegacyCreatureProjection(value: unknown): value is LegacyCreatureProjection {
  return isRecord(value) && typeof value.armorClass === "number" && typeof value.hitPoints === "number" && typeof value.speed === "string";
}

export function validateLegacyCreatureProjection(value: unknown): LegacyCreatureProjection {
  if (!isRecord(value)) fail("Legacy creature projection must be an object.");
  exactKeys(value, ["alignment", "armorClass", "challengeRating", "creatureType", "hitPoints", "size", "speed"], "legacy creature");
  if (typeof value.size !== "string" || !CREATURE_SIZES.includes(value.size as CreatureSize)) fail("Creature size is unsupported.");
  return {
    size: value.size as CreatureSize, creatureType: text(value.creatureType, "creatureType", 160),
    alignment: value.alignment === null ? null : text(value.alignment, "alignment", 160),
    armorClass: integer(value.armorClass, 1, 50, "armorClass"), hitPoints: integer(value.hitPoints, 1, 2147483647, "hitPoints"),
    challengeRating: normalizeChallengeRating(value.challengeRating), speed: text(value.speed, "speed", 200),
  };
}

export function creatureProjectionFromTypedFields(fields: unknown): CreatureProjection {
  if (!Array.isArray(fields)) fail("Canonical creature typedFields must be an array.");
  const values: Record<string, unknown> = {};
  for (const field of fields) if (isRecord(field) && typeof field.key === "string") values[toCamel(field.key)] = field.value;
  return validateCreatureProjection(values);
}

export function creatureEvidencePaths(projection: CreatureProjection): string[] {
  const paths: string[] = [];
  const indexed = new Set(["traits", "actions", "bonusActions", "reactions", "legendaryActions", "armorClass", "speeds", "damageResistances", "damageImmunities", "conditionImmunities", "senses", "languages"]);
  for (const [key, value] of Object.entries(projection)) {
    if (indexed.has(key) && Array.isArray(value) && value.length) value.forEach((_, index) => paths.push(`$.attributes.${key}[${index}]`));
    else if (key === "abilities") Object.keys(value as Record<string, unknown>).forEach((ability) => paths.push(`$.attributes.abilities.${ability}`));
    else paths.push(`$.attributes.${key}`);
  }
  return paths;
}

function validateChallengeRating(value: ChallengeRating): ChallengeRating {
  if (!Number.isSafeInteger(value.numerator) || !Number.isSafeInteger(value.denominator) || value.denominator < 1 || !CR_VALUES.has(`${value.numerator}/${value.denominator}`)) fail("Challenge rating must be 0, 1/8, 1/4, 1/2, or an integer from 1 to 30.");
  return value;
}
function blocks(value: unknown, field: string): CreatureBlock[] { return array(value, field, 0, 100).map((item, index) => { const row = object(item, `${field}[${index}]`); exactKeys(row, ["name", "text"], `${field}[${index}]`); return { name: text(row.name, `${field}[${index}].name`, 300), text: text(row.text, `${field}[${index}].text`, 10000) }; }); }
function modifierMap(value: unknown, field: string): Record<string, number> { const row = object(value, field); if (Object.keys(row).length > 100) fail(`${field} has too many entries.`); return Object.fromEntries(Object.entries(row).map(([key, item]) => [text(key, `${field} key`, 100), integer(item, -30, 30, `${field}.${key}`)])); }
function textList(value: unknown, field: string): string[] { return [...new Set(array(value, field, 0, 100).map((item, index) => text(item, `${field}[${index}]`, 500)))]; }
function array(value: unknown, field: string, min: number, max: number): unknown[] { if (!Array.isArray(value) || value.length < min || value.length > max) fail(`${field} must contain between ${min} and ${max} items.`); return value; }
function object(value: unknown, field: string): Record<string, unknown> { if (!isRecord(value)) fail(`${field} must be an object.`); return value; }
function integer(value: unknown, min: number, max: number, field: string): number { if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) fail(`${field} must be an integer from ${min} to ${max}.`); return Number(value); }
function text(value: unknown, field: string, max: number): string { if (typeof value !== "string" || !value.normalize("NFC").trim() || value.length > max || /<\s*\/?\s*[a-z][^>]*>/i.test(value)) fail(`${field} must be plain text of at most ${max} characters.`); return value.normalize("NFC").trim(); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void { if (Object.keys(value).sort().join(",") !== [...keys].sort().join(",")) fail(`${field} contains unsupported or missing fields.`); }
function toCamel(value: string): string { return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function fail(message: string): never { throw new CreatureValidationError(message); }
