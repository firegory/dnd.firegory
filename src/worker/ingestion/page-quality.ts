export type PageTextQuality = Readonly<{
  pageNumber: number;
  status: "good" | "corrupt";
  reasons: readonly string[];
  metrics: Readonly<{
    visibleCharacters: number;
    letters: number;
    wellShapedTokens: number;
    letterRatio: number;
    wordEvidenceRatio: number;
    cyrillicLetterRatio: number;
    intrudedTokenRatio: number;
    wellShapedTokenRatio: number;
    russianWordShapeRatio: number;
    invalidGlyphs: number;
    structuredContent: boolean;
  }>;
}>;

const LETTER = /\p{L}/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;
const INVALID_GLYPH = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uE000-\uF8FF\uFFFD]/u;
const RUSSIAN_VOWEL = /[аеёиоуыэюя]/iu;
export const MIN_LANGUAGE_QUALITY_CHARACTERS = 80;

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

/**
 * Detects broken custom-font ToUnicode mappings on Russian sources. The gate
 * deliberately requires several independent signals so non-Russian passages,
 * stat blocks, numeric tables, and source code remain valid content.
 */
export function assessPageTextQuality(
  pageNumber: number,
  text: string,
  language: "en" | "ru",
): PageTextQuality {
  const visible = [...text].filter((character) => !/\s/u.test(character));
  const tokens = text.match(/\S+/gu) ?? [];
  const letterTokens = tokens.filter((token) => LETTER.test(token));
  const cyrillicLetters = visible.filter((character) => CYRILLIC.test(character)).length;
  const latinLetters = visible.filter((character) => LATIN.test(character)).length;
  const letters = cyrillicLetters + latinLetters;
  const invalidGlyphs = visible.filter((character) => INVALID_GLYPH.test(character)).length;

  const intrudedTokens = letterTokens.filter((token) => {
    const core = token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    return LETTER.test(core) && /[^\p{L}\p{M}'’\-]/u.test(core);
  }).length;
  const wellShapedTokens = letterTokens.filter((token) => {
    const core = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    return core.length >= 2 && /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)?$/u.test(core);
  }).length;
  const cyrillicTokens = letterTokens.filter((token) => CYRILLIC.test(token));
  const russianWordShapes = cyrillicTokens.filter((token) => {
    const core = token.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, "");
    return core.length >= 2
      && /^[\p{Script=Cyrillic}\p{M}]+(?:['’\-][\p{Script=Cyrillic}\p{M}]+)?$/u.test(core)
      && RUSSIAN_VOWEL.test(core);
  }).length;
  const structuredNumericData = tokens.length >= 3
    && tokens.every((token) => token.length <= 32 && /^[\p{N}.,:+()\-/%]+$/u.test(token));
  const structuredSymbolContent = isStructuredSymbolContent(text, tokens);

  const metrics = {
    visibleCharacters: visible.length,
    letters,
    wellShapedTokens,
    letterRatio: ratio(letters, visible.length),
    wordEvidenceRatio: ratio(wellShapedTokens, Math.max(1, Math.ceil(visible.length / 40))),
    cyrillicLetterRatio: ratio(cyrillicLetters, visible.length),
    intrudedTokenRatio: ratio(intrudedTokens, letterTokens.length),
    wellShapedTokenRatio: ratio(wellShapedTokens, letterTokens.length),
    russianWordShapeRatio: ratio(russianWordShapes, cyrillicTokens.length),
    invalidGlyphs,
    structuredContent: structuredNumericData || structuredSymbolContent,
  };

  if (language !== "ru" || visible.length < MIN_LANGUAGE_QUALITY_CHARACTERS) {
    return { pageNumber, status: "good", reasons: [], metrics };
  }

  const englishPassage = latinLetters >= 30
    && ratio(latinLetters, latinLetters + cyrillicLetters) >= 0.75
    && metrics.wellShapedTokenRatio >= 0.65
    && metrics.intrudedTokenRatio < 0.2;
  const codeLike = cyrillicLetters < 5
    && latinLetters >= 15
    && /[{}[\];]|(?:=>|===|::|<\/?[a-z])/iu.test(text);
  if (englishPassage || codeLike || structuredNumericData || structuredSymbolContent) {
    return { pageNumber, status: "good", reasons: [], metrics };
  }

  const reasons: string[] = [];
  if (metrics.cyrillicLetterRatio < 0.22) reasons.push("implausibly-low-cyrillic-letter-ratio");
  if (metrics.letterRatio < 0.12) reasons.push("insufficient-letter-evidence");
  if (metrics.intrudedTokenRatio >= 0.25) reasons.push("punctuation-or-digit-intrusion");
  if (metrics.wellShapedTokenRatio < 0.5) reasons.push("failed-word-shape");
  if (cyrillicTokens.length >= 4 && metrics.russianWordShapeRatio < 0.45) reasons.push("failed-russian-lexical-shape");
  if (invalidGlyphs > 0) reasons.push("replacement-control-or-private-use-glyphs");

  const nonTextGarbage = visible.length >= 120
    && letterTokens.length < 8
    && metrics.letterRatio < 0.12;
  if (nonTextGarbage) reasons.push("long-non-text-garbage");

  const corrupt = nonTextGarbage || reasons.length >= 3
    || (invalidGlyphs > 0 && reasons.length >= 2);
  return { pageNumber, status: corrupt ? "corrupt" : "good", reasons: corrupt ? reasons : [], metrics };
}

function isStructuredSymbolContent(text: string, tokens: readonly string[]): boolean {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return false;

  const csvWidths = lines.map((line) => line.split(",").length);
  const csv = lines.length >= 2
    && csvWidths[0] >= 3
    && csvWidths.every((width) => width === csvWidths[0])
    && lines.every((line) => line.split(",").every((cell) => /^[\p{L}\p{N}_.+\-/%() ]+$/u.test(cell.trim())));
  if (csv) return true;

  const matrixRows = lines.filter((line) => {
    const numbers = line.match(/[+\-]?\d+(?:\.\d+)?/gu) ?? [];
    return numbers.length >= 2 && /^[\[\](){}|+\-\d.,;\s]+$/u.test(line) && bracketsBalanced(line);
  });
  if (matrixRows.length >= 2 && matrixRows.length / lines.length >= 0.75) return true;

  const equationLines = lines.filter((line) => {
    const equalSigns = [...line.matchAll(/(?<![<>=])=(?![=<>])/gu)];
    if (equalSigns.length !== 1 || !bracketsBalanced(line)) return false;
    const equals = equalSigns[0].index;
    if (equals <= 0 || equals >= line.length - 1) return false;
    const left = line.slice(0, equals);
    const right = line.slice(equals + 1);
    return /[\p{L}\p{N}]/u.test(left)
      && /[\p{L}\p{N}]/u.test(right)
      && /^[\p{L}\p{N}\p{M}\s+\-*/^=<>≤≥.,:;()[\]{}|]+$/u.test(line);
  });
  if (equationLines.length >= 2 && equationLines.length / lines.length >= 0.6) return true;

  const grammarTokens = tokens.filter((token) => token.length <= 64
    && /^(?:[\p{L}\p{N}_.]+|[+\-*/^=<>≤≥]+|[()[\]{}|,;:]+)$/u.test(token));
  const operators = tokens.filter((token) => /^[+\-*/^=<>≤≥]+$/u.test(token)).length;
  const operands = tokens.filter((token) => /[\p{L}\p{N}]/u.test(token)).length;
  return tokens.length >= 5
    && grammarTokens.length / tokens.length >= 0.85
    && operators >= 2
    && operands >= 3
    && bracketsBalanced(text);
}

function bracketsBalanced(text: string): boolean {
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const stack: string[] = [];
  for (const character of text) {
    if (character === "(" || character === "[" || character === "{") stack.push(character);
    else if (character in pairs && stack.pop() !== pairs[character]) return false;
  }
  return stack.length === 0;
}

export function hasMinimumTextEvidence(quality: PageTextQuality): boolean {
  if (quality.metrics.structuredContent) return true;
  const requiredWords = Math.max(2, Math.ceil(quality.metrics.visibleCharacters / 500));
  return quality.metrics.letters >= Math.max(12, Math.ceil(quality.metrics.visibleCharacters * 0.12))
    && quality.metrics.wellShapedTokens >= requiredWords;
}

export function assessPagesTextQuality(
  pages: readonly { pageNumber: number; text: string }[],
  language: "en" | "ru",
): readonly PageTextQuality[] {
  return pages.map((page) => assessPageTextQuality(page.pageNumber, page.text, language));
}

export function findPageQualityFailures(input: Readonly<{
  initiallyCorruptPages: ReadonlySet<number>;
  finalQuality: readonly PageTextQuality[];
  ocrAvailable: boolean;
  ocrFailureReason?: string | null;
  ocrReplacementPages: ReadonlySet<number>;
}>): readonly { pageNumber: number; reason: string }[] {
  const remainingCorruptPages = new Map(
    input.finalQuality
      .filter((quality) => quality.status === "corrupt")
      .map((quality) => [quality.pageNumber, quality]),
  );
  return [...input.initiallyCorruptPages].flatMap((pageNumber) => {
    const finalQuality = remainingCorruptPages.get(pageNumber);
    if (!input.ocrAvailable) {
      return [{
        pageNumber,
        reason: `forced OCR is unavailable${input.ocrFailureReason ? `: ${input.ocrFailureReason}` : ""}`,
      }];
    }
    if (!input.ocrReplacementPages.has(pageNumber)) {
      return [{
        pageNumber,
        reason: `forced OCR produced no replacement text that can be quality-scored${input.ocrFailureReason ? `: ${input.ocrFailureReason}` : ""}`,
      }];
    }
    const rescored = input.finalQuality.find((quality) => quality.pageNumber === pageNumber);
    if (finalQuality) {
      const evidence = hasMinimumTextEvidence(finalQuality)
        ? ""
        : "; forced OCR output has insufficient letter or word evidence";
      return [{ pageNumber, reason: `OCR text remains corrupt: ${finalQuality.reasons.join(", ")}${evidence}` }];
    }
    if (!rescored || !hasMinimumTextEvidence(rescored)) {
      return [{ pageNumber, reason: "forced OCR output has insufficient letter or word evidence" }];
    }
    return [];
  });
}
