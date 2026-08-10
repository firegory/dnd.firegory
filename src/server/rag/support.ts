import type { AnswerLanguage } from "./format.ts";
import type { RetrievalCandidate } from "../retrieval/types.ts";

const TOKEN_PATTERN = /[-+]?\d+d\d+|[-+]?\d+(?:[.,]\d+)?(?:\/\d+)?|[<>≤≥]|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)?/gu;
const MAX_SEGMENT_LENGTH = 800;

const FUNCTION_WORDS: Record<AnswerLanguage, ReadonlySet<string>> = {
  en: new Set([
    "a", "an", "and", "are", "has", "had", "have", "is", "the", "was", "were",
  ]),
  ru: new Set([
    "и",
  ]),
};

const PRONOUNS: Record<AnswerLanguage, ReadonlySet<string>> = {
  en: new Set([
    "he", "her", "hers", "him", "his", "it", "its", "she", "that", "their", "theirs", "them",
    "these", "they", "this", "those",
  ]),
  ru: new Set([
    "его", "ее", "ему", "ей", "им", "их", "она", "они", "оно", "он", "этим", "эти", "это", "эта", "этот",
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
  "ого", "его", "ому", "ему", "ой", "ей", "ую", "юю", "ом", "ем", "ым", "им",
  "ая", "яя", "ое", "ее", "ый", "ий", "а", "я", "у", "ю", "е",
] as const;

type Token = Readonly<{ value: string; functionWord: boolean }>;
type EvidenceSegment = Readonly<{ text: string; tokens: readonly Token[] }>;

export type ClaimSupportResult = Readonly<{
  supported: boolean;
  unsupportedTokens: readonly string[];
}>;

/** Requires one bounded authoritative segment to support the complete atomic claim. */
export function validateClaimSupport(
  claim: string,
  chunks: readonly RetrievalCandidate[],
  language: AnswerLanguage,
): ClaimSupportResult {
  const claimTokens = normalizeClaimStatOrder(canonicalTokens(claim, language).filter((token) => !token.functionWord));
  if (claimTokens.length === 0) return { supported: false, unsupportedTokens: [] };
  if (!pronounsAreBound(claimTokens, language)) {
    return {
      supported: false,
      unsupportedTokens: claimTokens.filter((token) => PRONOUNS[language].has(token.value)).map((token) => token.value),
    };
  }

  const segmentsByContext = chunks.map((chunk) => evidenceSegments(chunk, language));
  const supported = segmentsByContext.length > 0 && segmentsByContext.every((segments) =>
    segments.some((segment) => segmentSupportsClaim(claimTokens, segment, language)),
  );
  if (supported) return { supported: true, unsupportedTokens: [] };

  const segments = segmentsByContext.flat();
  const evidenceTokens = segments.flatMap((segment) => segment.tokens).filter((token) => !token.functionWord);
  const unsupportedTokens = claimTokens
    .filter((token) => !evidenceTokens.some((evidence) => tokensMatch(token.value, evidence.value, language)))
    .map((token) => token.value);
  return { supported: false, unsupportedTokens };
}

function pronounsAreBound(tokens: readonly Token[], language: AnswerLanguage): boolean {
  let explicitSubjectSeen = false;
  for (const token of tokens) {
    if (PRONOUNS[language].has(token.value)) {
      if (!explicitSubjectSeen) return false;
    } else if (!token.value.startsWith("label-") && !isNumericToken(token.value) && !token.value.startsWith("unit-")) {
      explicitSubjectSeen = true;
    }
  }
  return true;
}

function segmentSupportsClaim(
  claimTokens: readonly Token[],
  segment: EvidenceSegment,
  language: AnswerLanguage,
): boolean {
  const evidenceTokens = segment.tokens.filter((token) => !token.functionWord);
  if (!contiguousSequence(claimTokens, evidenceTokens, language)) return false;
  return statAssociationsSupported(claimTokens, evidenceTokens)
    && comparisonSymbolsSupported(claimTokens, evidenceTokens);
}

function contiguousSequence(
  claimTokens: readonly Token[],
  evidenceTokens: readonly Token[],
  language: AnswerLanguage,
): boolean {
  if (claimTokens.length > evidenceTokens.length) return false;
  return evidenceTokens.some((_, start) => claimTokens.every((claimToken, offset) =>
    tokensMatch(claimToken.value, evidenceTokens[start + offset]?.value ?? "", language),
  ));
}

function normalizeClaimStatOrder(tokens: readonly Token[]): Token[] {
  const normalized: Token[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (isNumericToken(tokens[index].value) && tokens[index + 1]?.value.startsWith("label-")) {
      normalized.push(tokens[index + 1], tokens[index]);
      index++;
    } else {
      normalized.push(tokens[index]);
    }
  }
  return normalized;
}

function tokensMatch(claim: string, evidence: string, language: AnswerLanguage): boolean {
  if (claim === evidence) return true;
  if (language !== "ru" || claim.length < 5 || evidence.length < 5) return false;
  const claimStem = russianStem(claim);
  return claimStem.length >= 5 && claimStem === russianStem(evidence);
}

function evidenceSegments(chunk: RetrievalCandidate, language: AnswerLanguage): EvidenceSegment[] {
  const segments: EvidenceSegment[] = [];
  for (const rawLine of chunk.quoteText.split(/\r?\n/)) {
    const line = rawLine.replaceAll(/\s+/g, " ").trim();
    if (!line) continue;
    const parts = isTableRow(line) ? tableRowSegments(line) : line.split(/(?<=[.!?;])\s+/u);
    for (const part of parts) {
      for (const bounded of boundSegment(part)) {
        const text = prefixSection(chunk.sectionHeading, bounded);
        segments.push({ text, tokens: canonicalTokens(text, language) });
      }
    }
  }
  return segments;
}

function isTableRow(line: string): boolean {
  return line.includes("|") || line.includes("\t");
}

function tableRowSegments(line: string): string[] {
  const cells = line.split(/[|\t]/).map((cell) => cell.trim()).filter(Boolean);
  if (cells.length < 2) return [line];
  const firstTokens = tokenize(cells[0]);
  if (firstTokens.some((_, index) => labelAt(firstTokens, index))) {
    return [cells.join(" ")];
  }
  const segments: string[] = [];
  const anchor = cells[0];
  let fieldsStarted = false;
  for (const cell of cells.slice(1)) {
    const tokens = tokenize(cell);
    if (tokens.some((_, index) => labelAt(tokens, index))) {
      fieldsStarted = true;
      segments.push(`${anchor} ${cell}`);
    } else if (fieldsStarted) {
      break;
    } else {
      segments.push(`${anchor} ${cell}`);
    }
  }
  return segments.length > 0 ? segments : [line];
}

function boundSegment(value: string): string[] {
  const segments: string[] = [];
  let remaining = value.trim();
  while (remaining) {
    if (remaining.length <= MAX_SEGMENT_LENGTH) {
      segments.push(remaining);
      break;
    }
    const boundary = remaining.lastIndexOf(" ", MAX_SEGMENT_LENGTH);
    const end = boundary >= MAX_SEGMENT_LENGTH / 2 ? boundary : MAX_SEGMENT_LENGTH;
    segments.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  return segments;
}

function prefixSection(section: string | null, segment: string): string {
  if (!section?.trim()) return segment;
  const normalizedSection = section.replaceAll(/\s+/g, " ").trim();
  if (containsTokenSequence(tokenize(segment), tokenize(normalizedSection))) return segment;
  return `${normalizedSection}: ${segment}`.slice(0, MAX_SEGMENT_LENGTH);
}

function containsTokenSequence(tokens: readonly string[], expected: readonly string[]): boolean {
  if (expected.length === 0) return true;
  return tokens.some((_, index) => expected.every((token, offset) => tokens[index + offset] === token));
}

function canonicalTokens(value: string, language: AnswerLanguage): Token[] {
  const raw = tokenize(value);
  const tokens: Token[] = [];
  for (let index = 0; index < raw.length; index++) {
    const label = labelAt(raw, index);
    if (label) {
      tokens.push({ value: `label-${label.id}`, functionWord: false });
      index += label.length - 1;
      continue;
    }
    const unit = UNIT_BY_TOKEN.get(raw[index]);
    const normalized = unit ?? raw[index];
    tokens.push({ value: normalized, functionWord: FUNCTION_WORDS[language].has(normalized) });
  }
  return tokens;
}

function tokenize(value: string): string[] {
  const normalized = value.normalize("NFC").toLocaleLowerCase("und").replaceAll(/([+-])\s+(?=\d)/g, "$1");
  return [...normalized.matchAll(TOKEN_PATTERN)].map((match) => normalizePossessive(match[0]));
}

function normalizePossessive(token: string): string {
  return token.endsWith("'s") || token.endsWith("’s") ? token.slice(0, -2) : token;
}

function russianStem(token: string): string {
  for (const suffix of RU_SUFFIXES) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 5) return token.slice(0, -suffix.length);
  }
  return token;
}

function statAssociationsSupported(claim: readonly Token[], evidence: readonly Token[]): boolean {
  const claimPairs = extractLabelValues(claim);
  const evidencePairs = extractLabelValues(evidence);
  return claimPairs.every((pair) => evidencePairs.some((candidate) =>
    candidate.label === pair.label && candidate.value === pair.value,
  )) && numberUnitsSupported(claim, evidence);
}

function extractLabelValues(tokens: readonly Token[]): Array<{ label: string; value: string }> {
  const pairs: Array<{ label: string; value: string }> = [];
  for (let index = 0; index < tokens.length; index++) {
    if (!tokens[index].value.startsWith("label-")) continue;
    let value: string | undefined;
    for (const candidate of tokens.slice(index + 1, index + 6)) {
      if (candidate.value.startsWith("label-")) break;
      if (isNumericToken(candidate.value)) {
        value = candidate.value;
        break;
      }
    }
    if (value) pairs.push({ label: tokens[index].value, value });
  }
  return pairs;
}

function numberUnitsSupported(claim: readonly Token[], evidence: readonly Token[]): boolean {
  for (let index = 0; index < claim.length; index++) {
    if (!isNumericToken(claim[index].value)) continue;
    const unit = claim.slice(index + 1, index + 3).find((token) => token.value.startsWith("unit-"))?.value;
    if (!unit) continue;
    const supported = evidence.some((token, evidenceIndex) => token.value === claim[index].value
      && evidence.slice(evidenceIndex + 1, evidenceIndex + 3).some((candidate) => candidate.value === unit));
    if (!supported) return false;
  }
  return true;
}

function comparisonSymbolsSupported(claim: readonly Token[], evidence: readonly Token[]): boolean {
  const symbols = claim.filter((token) => /^[<>≤≥]$/.test(token.value));
  return symbols.every((symbol) => evidence.some((token) => token.value === symbol.value));
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

function isNumericToken(token: string): boolean {
  return /^[-+]?\d+(?:[.,]\d+)?(?:\/\d+)?$/.test(token);
}
