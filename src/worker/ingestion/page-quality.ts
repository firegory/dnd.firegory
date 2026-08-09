export type PageTextQuality = Readonly<{
  pageNumber: number;
  status: "good" | "corrupt";
  reasons: readonly string[];
  metrics: Readonly<{
    visibleCharacters: number;
    cyrillicLetterRatio: number;
    intrudedTokenRatio: number;
    wellShapedTokenRatio: number;
    russianWordShapeRatio: number;
    invalidGlyphs: number;
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

  const metrics = {
    visibleCharacters: visible.length,
    cyrillicLetterRatio: ratio(cyrillicLetters, visible.length),
    intrudedTokenRatio: ratio(intrudedTokens, letterTokens.length),
    wellShapedTokenRatio: ratio(wellShapedTokens, letterTokens.length),
    russianWordShapeRatio: ratio(russianWordShapes, cyrillicTokens.length),
    invalidGlyphs,
  };

  if (language !== "ru" || visible.length < MIN_LANGUAGE_QUALITY_CHARACTERS || letterTokens.length < 8) {
    return { pageNumber, status: "good", reasons: [], metrics };
  }

  const englishPassage = latinLetters >= 30
    && ratio(latinLetters, latinLetters + cyrillicLetters) >= 0.75
    && metrics.wellShapedTokenRatio >= 0.65
    && metrics.intrudedTokenRatio < 0.2;
  const codeLike = cyrillicLetters < 5
    && latinLetters >= 15
    && /[{}[\];]|(?:=>|===|::|<\/?[a-z])/iu.test(text);
  if (englishPassage || codeLike) {
    return { pageNumber, status: "good", reasons: [], metrics };
  }

  const reasons: string[] = [];
  if (metrics.cyrillicLetterRatio < 0.22) reasons.push("implausibly-low-cyrillic-letter-ratio");
  if (metrics.intrudedTokenRatio >= 0.25) reasons.push("punctuation-or-digit-intrusion");
  if (metrics.wellShapedTokenRatio < 0.5) reasons.push("failed-word-shape");
  if (cyrillicTokens.length >= 4 && metrics.russianWordShapeRatio < 0.45) reasons.push("failed-russian-lexical-shape");
  if (invalidGlyphs > 0) reasons.push("replacement-control-or-private-use-glyphs");

  const corrupt = reasons.length >= 3
    || (invalidGlyphs > 0 && reasons.length >= 2);
  return { pageNumber, status: corrupt ? "corrupt" : "good", reasons: corrupt ? reasons : [], metrics };
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
  ocrReplacementPages: ReadonlySet<number>;
}>): readonly { pageNumber: number; reason: string }[] {
  const remainingCorruptPages = new Map(
    input.finalQuality
      .filter((quality) => quality.status === "corrupt")
      .map((quality) => [quality.pageNumber, quality]),
  );
  return [...input.initiallyCorruptPages].flatMap((pageNumber) => {
    const finalQuality = remainingCorruptPages.get(pageNumber);
    if (!input.ocrAvailable) return [{ pageNumber, reason: "forced OCR is unavailable" }];
    if (!input.ocrReplacementPages.has(pageNumber)) {
      return [{ pageNumber, reason: "forced OCR produced no replacement text that can be quality-scored" }];
    }
    if (finalQuality) {
      return [{ pageNumber, reason: `OCR text remains corrupt: ${finalQuality.reasons.join(", ")}` }];
    }
    return [];
  });
}
