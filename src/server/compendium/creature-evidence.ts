import type { CreatureBlock, CreatureProjection } from "./creature-schema.ts";

const ABILITY_LABELS: Readonly<Record<string, readonly string[]>> = {
  str: ["STR", "СИЛ"], dex: ["DEX", "ЛОВ"], con: ["CON", "ТЕЛ"],
  int: ["INT", "ИНТ"], wis: ["WIS", "МДР"], cha: ["CHA", "ХАР"],
};
const SPEED_MODES: Readonly<Record<string, CreatureProjection["speeds"][number]["mode"]>> = {
  walk: "walk", burrow: "burrow", climb: "climb", fly: "fly", swim: "swim",
  ходьба: "walk", копая: "burrow", лазая: "climb", летая: "fly", лётая: "fly", плавая: "swim",
};

export function creatureFieldEvidenceSupports(path: string, value: unknown, quote: string): boolean {
  const field = path.match(/^\$\.attributes\.([A-Za-z]+)/)?.[1] ?? "";
  if (field === "abilities") {
    const key = path.split(".").at(-1) ?? "";
    const labels = ABILITY_LABELS[key] ?? [];
    return typeof value === "number" && labels.some((label) => abilityValue(quote, label) === value);
  }
  if (field === "saves" || field === "skills") {
    const labels = field === "saves" ? ["Saving Throws", "Спасброски"] : ["Skills", "Навыки"];
    const evidence = labelledValue(quote, labels);
    return evidence !== null && sameModifierMap(value, parseModifiers(evidence));
  }
  if (field === "speeds") {
    if (!isRecord(value)) return false;
    const evidence = labelledValue(quote, ["Speed", "Скорость"]);
    if (evidence === null && !/^(?:walk|burrow|climb|fly|swim|ходьба|копая|лазая|л[её]тая|плавая)\b/iu.test(quote.trim())) return false;
    const speeds = parseSpeeds(evidence ?? quote);
    return speeds.some((speed) => sameRecord(value, speed));
  }
  if (field === "armorClass") {
    if (!isRecord(value)) return false;
    const match = labelledValue(quote, ["Armor Class", "Класс Доспеха", "КД"])?.match(/^(\d+)(?:\s*\(([^)]+)\))?/u);
    return Boolean(match) && sameRecord(value, { value: Number(match![1]), ...(match![2] ? { note: match![2].trim() } : {}) });
  }
  if (field === "hitPoints") {
    if (!isRecord(value)) return false;
    const match = labelledValue(quote, ["Hit Points", "Хиты"])?.match(/^(\d+)(?:\s*\(([^)]+)\))?/u);
    return Boolean(match) && sameRecord(value, { average: Number(match![1]), ...(match![2] ? { formula: match![2].replace(/\s+/g, " ").trim() } : {}) });
  }
  if (field === "challengeRating") {
    if (!isRecord(value)) return false;
    const evidence = labelledValue(quote, ["Challenge Rating", "Challenge", "Показатель опасности", "Опасность"])
      ?? quote.match(/^(?:challenge_rating|challenge|cr)\s*=\s*(.*)$/u)?.[1];
    if (evidence === undefined || evidence === null) return false;
    const match = evidence.match(/^(\d+)(?:\s*\/\s*(\d+))?(?:\s|$)/u);
    return Boolean(match) && Number(value.numerator) * Number(match![2] ?? 1) === Number(match![1]) * Number(value.denominator);
  }
  if (["traits", "actions", "bonusActions", "reactions", "legendaryActions"].includes(field)) {
    if (!isRecord(value)) return false;
    const block = parseBlock(quote);
    return block !== null && value.name === block.name && value.text === block.text;
  }
  return scalarValues(value).every((scalar) => typeof scalar === "number"
    ? numericValues(quote).includes(scalar)
    : normalize(quote).includes(normalize(scalar)));
}

export function abilityEvidenceQuote(body: string, key: string): string | null {
  const labels = ABILITY_LABELS[key] ?? [];
  const allLabels = Object.values(ABILITY_LABELS).flat().map(escapeRegExp).join("|");
  for (const label of labels) {
    const match = body.match(new RegExp(`(?:^|\\s)(${escapeRegExp(label)}\\s+\\d+(?:\\s*\\([^)]+\\))?)(?=\\s+(?:${allLabels})\\b|$)`, "imu"));
    if (match?.[1]) return match[1];
  }
  return null;
}

export function speedEvidenceQuote(line: string, mode: string): string | null {
  const labelled = stripLabel(line, ["Speed", "Скорость"]);
  for (const [index, part] of labelled.split(/[,;]/).entries()) {
    const parsed = parseSpeeds(part, index);
    if (parsed.some((speed) => speed.mode === mode)) return `${index === 0 ? line.slice(0, line.indexOf(labelled)) : ""}${part.trim()}`.trim();
  }
  return null;
}

function parseSpeeds(value: string, indexOffset = 0): Record<string, unknown>[] {
  return value.split(/[,;]/).flatMap((part, index) => {
    const match = part.trim().match(/(?:(walk|burrow|climb|fly|swim|ходьба|копая|лазая|л[её]тая|плавая)\s*)?(\d+)\s*(ft|feet|фут(?:ов|а)?|m|м)\.?\s*(?:\(([^)]+)\))?/iu);
    if (!match) return [];
    const mode = SPEED_MODES[match[1]?.toLocaleLowerCase("und") ?? ""] ?? (index + indexOffset === 0 ? "walk" : null);
    return mode ? [{ mode, distance: Number(match[2]), unit: /^m|м$/iu.test(match[3]) ? "m" : "ft", ...(match[4] ? { note: match[4].trim() } : {}) }] : [];
  });
}

function parseModifiers(value: string): Record<string, number> {
  return Object.fromEntries([...value.matchAll(/([\p{L}][\p{L} ]*?)\s*([+-]\d+)/gu)].map((match) => [normalize(match[1]), Number(match[2])]));
}
function sameModifierMap(value: unknown, parsed: Record<string, number>): boolean {
  if (!isRecord(value) || Object.keys(value).length !== Object.keys(parsed).length) return false;
  return Object.entries(value).every(([key, modifier]) => typeof modifier === "number" && parsed[normalize(key)] === modifier);
}
function parseBlock(quote: string): CreatureBlock | null { const match = quote.match(/^(.{1,300}?[.!?])\s+(.+)$/u); return match ? { name: match[1].replace(/[.!?]$/, "").trim(), text: match[2].trim() } : null; }
function labelledValue(value: string, labels: readonly string[]): string | null { for (const label of [...labels].sort((a,b)=>b.length-a.length)) { const match=value.match(new RegExp(`^${escapeRegExp(label)}\\s*:?\\s*(.*)$`,"iu")); if(match)return match[1]; } return null; }
function stripLabel(value: string, labels: readonly string[]): string { return labelledValue(value, labels) ?? value; }
function abilityValue(quote: string, label: string): number | null { const match=quote.match(new RegExp(`(?:^|\\s)${escapeRegExp(label)}\\s+(\\d+)`,"iu")); return match ? Number(match[1]) : null; }
function sameRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean { return JSON.stringify(sortRecord(left)) === JSON.stringify(sortRecord(right)); }
function sortRecord(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b))); }
function scalarValues(value: unknown): (string|number)[] { if(Array.isArray(value))return value.flatMap(scalarValues); if(isRecord(value))return Object.values(value).flatMap(scalarValues); return typeof value==="string"||typeof value==="number"?[value]:[]; }
function numericValues(value:string):number[]{return [...value.matchAll(/(?<![\d/])-?\d+(?:\.\d+)?(?:\s*\/\s*\d+)?(?![\d/])/g)].map((match)=>{const [left,right]=match[0].split("/").map(Number);return right?left/right:left;});}
function normalize(value:string):string{return value.normalize("NFKD").replace(/\p{M}+/gu,"").toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu," ").trim();}
function escapeRegExp(value:string):string{return value.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}
function isRecord(value:unknown):value is Record<string,unknown>{return typeof value==="object"&&value!==null&&!Array.isArray(value);}
