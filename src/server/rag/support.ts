import type { AnswerLanguage } from "./format.ts";
import type { RetrievalCandidate } from "../retrieval/types.ts";

const TOKEN_PATTERN = /[-+]?\d+d\d+|[-+]?\d+(?:[.,]\d+)?(?:\/\d+)?|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;

const FUNCTION_WORDS: Record<AnswerLanguage, ReadonlySet<string>> = {
  en: new Set([
    "a", "an", "and", "are", "as", "at", "by", "for", "from", "has", "have", "in", "is",
    "it", "its", "of", "on", "or", "that", "the", "their", "this", "to", "was", "were", "with",
  ]),
  ru: new Set([
    "а", "в", "во", "для", "его", "ее", "и", "из", "или", "их", "к", "ко", "на", "о", "об",
    "от", "по", "с", "со", "у", "это", "эта", "этот", "эти", "за",
  ]),
};

const UNIT_GROUPS = [
  ["ft", "foot", "feet", "фут", "фута", "футов"],
  ["m", "meter", "meters", "metre", "metres", "м", "метр", "метра", "метров"],
  ["lb", "lbs", "pound", "pounds", "фунт", "фунта", "фунтов"],
  ["round", "rounds", "раунд", "раунда", "раундов"],
] as const;

const UNIT_BY_TOKEN = new Map<string, string>(
  UNIT_GROUPS.flatMap((group, index) => group.map((token) => [token, `unit-${index}`])),
);

const LABELS: readonly Readonly<{ id: string; forms: readonly string[] }>[] = [
  { id: "ac", forms: ["armor class", "ac", "класс доспеха", "кд"] },
  { id: "hp", forms: ["hit points", "hp", "хиты", "пункты хитов"] },
  { id: "speed", forms: ["speed", "скорость"] },
  { id: "challenge", forms: ["challenge rating", "cr", "опасность"] },
  { id: "str", forms: ["strength", "str", "сила", "сил"] },
  { id: "dex", forms: ["dexterity", "dex", "ловкость", "лов"] },
  { id: "con", forms: ["constitution", "con", "телосложение", "тел"] },
  { id: "int", forms: ["intelligence", "int", "интеллект", "инт"] },
  { id: "wis", forms: ["wisdom", "wis", "мудрость", "мдр"] },
  { id: "cha", forms: ["charisma", "cha", "харизма", "хар"] },
];

const RU_SUFFIXES = [
  "иями", "ями", "ами", "ого", "его", "ому", "ему", "ыми", "ими", "иях", "ах", "ях",
  "ов", "ев", "ой", "ей", "ам", "ям", "ую", "юю", "ые", "ие", "ых", "их", "ом", "ем",
  "ая", "яя", "ое", "ее", "ый", "ий", "а", "я", "у", "ю", "е", "ы", "и",
] as const;

export type ClaimSupportResult = Readonly<{
  supported: boolean;
  unsupportedTokens: readonly string[];
}>;

/** Conservative lexical entailment and stat-label association gate. */
export function validateClaimSupport(
  claim: string,
  chunks: readonly RetrievalCandidate[],
  language: AnswerLanguage,
): ClaimSupportResult {
  const claimTokens = tokenize(claim);
  const evidenceTokens = chunks.flatMap((chunk) => tokenize(chunk.quoteText));
  const contentTokens = claimTokens.filter((token) => !FUNCTION_WORDS[language].has(token));
  const unsupportedTokens = contentTokens.filter((token) => !hasSupportedToken(token, evidenceTokens, language));

  if (contentTokens.length === 0 || !symbolsSupported(claim, chunks) || !statAssociationsSupported(claimTokens, chunks)) {
    return { supported: false, unsupportedTokens };
  }
  return { supported: unsupportedTokens.length === 0, unsupportedTokens };
}

function tokenize(value: string): string[] {
  const normalized = value.normalize("NFC").toLocaleLowerCase("und").replaceAll(/([+-])\s+(?=\d)/g, "$1");
  return [...normalized.matchAll(TOKEN_PATTERN)]
    .map((match) => normalizePossessive(match[0]));
}

function normalizePossessive(token: string): string {
  return token.endsWith("'s") || token.endsWith("’s") ? token.slice(0, -2) : token;
}

function hasSupportedToken(token: string, evidence: readonly string[], language: AnswerLanguage): boolean {
  if (evidence.includes(token)) return true;
  const unit = UNIT_BY_TOKEN.get(token);
  if (unit && evidence.some((candidate) => UNIT_BY_TOKEN.get(candidate) === unit)) return true;
  if (labelForSingleToken(token) && evidenceContainsLabel(evidence, labelForSingleToken(token)!)) return true;
  if (language !== "ru" || token.length < 5) return false;
  const stem = russianStem(token);
  return stem.length >= 5 && evidence.some((candidate) => candidate.length >= 5 && russianStem(candidate) === stem);
}

function russianStem(token: string): string {
  for (const suffix of RU_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 5) return token.slice(0, -suffix.length);
  }
  return token;
}

function symbolsSupported(claim: string, chunks: readonly RetrievalCandidate[]): boolean {
  const evidence = chunks.map((chunk) => chunk.quoteText).join("\n");
  return [...claim.matchAll(/[<>≤≥]/g)].every((match) => evidence.includes(match[0]));
}

function statAssociationsSupported(claimTokens: readonly string[], chunks: readonly RetrievalCandidate[]): boolean {
  const claimPairs = extractLabelValues(claimTokens);
  if (claimPairs.length === 0) return unitsSupported(claimTokens, chunks);
  const evidencePairs = chunks.flatMap((chunk) => extractLabelValues(tokenize(chunk.quoteText)));
  return claimPairs.every((pair) => evidencePairs.some((candidate) =>
    candidate.label === pair.label && candidate.value === pair.value,
  )) && unitsSupported(claimTokens, chunks);
}

function extractLabelValues(tokens: readonly string[]): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    const label = labelAt(tokens, index);
    if (!label) continue;
    const following = tokens.slice(index + label.length, index + label.length + 6);
    const value = following.find(isNumericToken);
    if (value) pairs.push({ label: label.id, value });
    index += label.length - 1;
  }
  return pairs;
}

function unitsSupported(claimTokens: readonly string[], chunks: readonly RetrievalCandidate[]): boolean {
  const evidenceTokens = chunks.map((chunk) => tokenize(chunk.quoteText));
  for (let index = 0; index < claimTokens.length; index++) {
    if (!isNumericToken(claimTokens[index])) continue;
    const unit = claimTokens.slice(index + 1, index + 3).map((token) => UNIT_BY_TOKEN.get(token)).find(Boolean);
    if (!unit) continue;
    const found = evidenceTokens.some((tokens) => tokens.some((token, evidenceIndex) =>
      token === claimTokens[index]
      && tokens.slice(evidenceIndex + 1, evidenceIndex + 3).some((candidate) => UNIT_BY_TOKEN.get(candidate) === unit),
    ));
    if (!found) return false;
  }
  return true;
}

function labelAt(tokens: readonly string[], index: number): { id: string; length: number } | undefined {
  for (const label of LABELS) {
    for (const form of label.forms) {
      const formTokens = form.split(" ");
      if (formTokens.every((token, offset) => tokens[index + offset] === token)) {
        return { id: label.id, length: formTokens.length };
      }
    }
  }
  return undefined;
}

function labelForSingleToken(token: string): string | undefined {
  return LABELS.find((label) => label.forms.some((form) => form === token))?.id;
}

function evidenceContainsLabel(tokens: readonly string[], id: string): boolean {
  return tokens.some((_, index) => labelAt(tokens, index)?.id === id);
}

function isNumericToken(token: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?(?:\/\d+)?$/.test(token);
}
