export const SPELL_SCHOOLS = [
  "abjuration", "conjuration", "divination", "enchantment", "evocation",
  "illusion", "necromancy", "transmutation",
] as const;

export type SpellSchool = (typeof SPELL_SCHOOLS)[number];

export type SpellProjection = Readonly<{
  level: number;
  school: SpellSchool;
  ritual: boolean;
  concentration: boolean;
  castingTime: string;
  range: string;
  duration: string;
  components: string;
  classes: readonly string[];
}>;

export class SpellValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpellValidationError";
  }
}

export function validateSpellProjection(value: unknown): SpellProjection {
  if (!isRecord(value)) throw new SpellValidationError("Spell projection must be an object.");
  if (!Number.isSafeInteger(value.level) || Number(value.level) < 0 || Number(value.level) > 9) {
    throw new SpellValidationError("Spell level must be an integer from 0 to 9.");
  }
  if (typeof value.school !== "string" || !SPELL_SCHOOLS.includes(value.school as SpellSchool)) {
    throw new SpellValidationError("Spell school is unsupported.");
  }
  for (const field of ["castingTime", "range", "duration", "components"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new SpellValidationError(`Spell ${field} is required.`);
  }
  if (typeof value.ritual !== "boolean" || typeof value.concentration !== "boolean") {
    throw new SpellValidationError("Spell ritual and concentration flags must be boolean.");
  }
  if (!Array.isArray(value.classes) || value.classes.some((item) => typeof item !== "string" || !item.trim())) {
    throw new SpellValidationError("Spell classes must be nonblank strings.");
  }
  const castingTime = String(value.castingTime).trim();
  const range = String(value.range).trim();
  const duration = String(value.duration).trim();
  const components = String(value.components).trim();
  const classes = [...new Set(value.classes.map((item) => String(item).normalize("NFC").trim()))];
  return {
    level: Number(value.level), school: value.school as SpellSchool,
    ritual: value.ritual, concentration: value.concentration,
    castingTime, range, duration, components, classes,
  };
}

export function spellProjectionFromTypedFields(fields: unknown): SpellProjection {
  if (!Array.isArray(fields)) throw new SpellValidationError("Canonical spell typedFields must be an array.");
  const values: Record<string, unknown> = {};
  for (const field of fields) {
    if (isRecord(field) && typeof field.key === "string") values[toCamelCase(field.key)] = field.value;
  }
  values.classes ??= [];
  return validateSpellProjection(values);
}

function toCamelCase(value: string): string {
  return value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
