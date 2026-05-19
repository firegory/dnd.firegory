/**
 * Text chunking with source/page/section/span metadata.
 *
 * Splits extracted page text into quote-safe chunks with:
 * - Configurable target chunk size and overlap
 * - Page number and section heading metadata
 * - Character-level text span offsets for citation precision
 */

export type ChunkInput = Readonly<{
  pageNumber: number;
  text: string;
  sectionHeading?: string;
}>;

export type TextChunk = Readonly<{
  chunkIndex: number;
  text: string;
  quoteText: string;
  pageNumber: number;
  sectionHeading: string | null;
  textSpanStart: number;
  textSpanEnd: number;
  charCount: number;
}>;

export type ChunkingConfig = Readonly<{
  /** Target characters per chunk (default: 1000) */
  targetChunkSize: number;
  /** Overlap in characters between adjacent chunks (default: 200) */
  overlapSize: number;
  /** Minimum characters for a chunk (shorter tails are merged into previous chunk) */
  minChunkSize: number;
}>;

const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  targetChunkSize: 1000,
  overlapSize: 200,
  minChunkSize: 100,
};

/**
 * Splits a single page's text into chunks with span metadata.
 *
 * Uses paragraph-aware splitting: tries to break at paragraph boundaries
 * (double newlines) within the target size window, then falls back to
 * sentence boundaries (period + space), then to arbitrary character breaks.
 */
export function chunkPage(
  input: ChunkInput,
  globalChunkIndex: number,
  config: Partial<ChunkingConfig> = {},
): TextChunk[] {
  const cfg = { ...DEFAULT_CHUNKING_CONFIG, ...config };
  const { text } = input;

  if (text.trim().length === 0) {
    return [];
  }

  const chunks: TextChunk[] = [];
  let position = 0;
  let chunkIndex = globalChunkIndex;

  while (position < text.length) {
    const endPosition = Math.min(position + cfg.targetChunkSize, text.length);

    // If we're at the end, just take what's left
    if (endPosition >= text.length) {
      const chunkText = text.slice(position);
      if (chunkText.trim().length > 0) {
        // If this tail is too short, merge into previous chunk
        if (chunks.length > 0 && chunkText.trim().length < cfg.minChunkSize) {
          const prev = chunks[chunks.length - 1];
          const mergedText = prev.text + "\n" + chunkText;
          chunks[chunks.length - 1] = {
            ...prev,
            text: mergedText,
            quoteText: cleanQuoteText(mergedText),
            textSpanEnd: position + chunkText.length,
            charCount: mergedText.length,
          };
        } else {
          chunks.push(makeChunk(chunkIndex, chunkText, input, position, position + chunkText.length));
          chunkIndex++;
        }
      }
      break;
    }

    // Try to find a good break point within the window
    const window = text.slice(position, endPosition);
    const breakPoint = findBreakPoint(window, cfg.targetChunkSize);

    const chunkText = text.slice(position, position + breakPoint);

    if (chunkText.trim().length > 0) {
      chunks.push(makeChunk(chunkIndex, chunkText, input, position, position + breakPoint));
      chunkIndex++;
    }

    // Advance past the break, with overlap
    position = position + Math.max(breakPoint - cfg.overlapSize, 1);
  }

  return chunks;
}

/**
 * Chunks multiple pages, maintaining a global chunk index.
 */
export function chunkPages(
  pages: readonly ChunkInput[],
  config: Partial<ChunkingConfig> = {},
): TextChunk[] {
  const allChunks: TextChunk[] = [];
  let globalIndex = 0;

  for (const page of pages) {
    const pageChunks = chunkPage(page, globalIndex, config);
    allChunks.push(...pageChunks);
    globalIndex += pageChunks.length;
  }

  // Re-index to ensure global sequential ordering
  return allChunks.map((chunk, i) => ({
    ...chunk,
    chunkIndex: i,
  }));
}

/**
 * Finds a good break point within a text window.
 * Prefers paragraph boundaries, then sentence boundaries, then arbitrary.
 */
function findBreakPoint(window: string, targetSize: number): number {
  // Try paragraph break (double newline) near the target
  const paragraphBreak = findLastInRange(
    window,
    "\n\n",
    Math.floor(targetSize * 0.5),
    targetSize,
  );
  if (paragraphBreak !== null) {
    return paragraphBreak + 2; // Include the double newline
  }

  // Try single newline
  const newlineBreak = findLastInRange(
    window,
    "\n",
    Math.floor(targetSize * 0.5),
    targetSize,
  );
  if (newlineBreak !== null) {
    return newlineBreak + 1;
  }

  // Try sentence end (period/space)
  const sentenceEnd = findLastInRange(
    window,
    ". ",
    Math.floor(targetSize * 0.3),
    targetSize,
  );
  if (sentenceEnd !== null) {
    return sentenceEnd + 2; // Include the period and space
  }

  // No good break point found — just cut at target size
  return targetSize;
}

/**
 * Finds the last occurrence of needle in haystack within [from, to] range.
 */
function findLastInRange(
  haystack: string,
  needle: string,
  from: number,
  to: number,
): number | null {
  const searchEnd = Math.min(to, haystack.length);
  const searchFrom = Math.max(from, 0);

  let lastIdx = -1;
  let idx = haystack.indexOf(needle, searchFrom);
  while (idx !== -1 && idx < searchEnd) {
    lastIdx = idx;
    idx = haystack.indexOf(needle, idx + 1);
  }

  return lastIdx >= 0 ? lastIdx : null;
}

/**
 * Creates a TextChunk with quote-safe text.
 */
function makeChunk(
  chunkIndex: number,
  text: string,
  input: ChunkInput,
  spanStart: number,
  spanEnd: number,
): TextChunk {
  return {
    chunkIndex,
    text,
    quoteText: cleanQuoteText(text),
    pageNumber: input.pageNumber,
    sectionHeading: input.sectionHeading ?? null,
    textSpanStart: spanStart,
    textSpanEnd: spanEnd,
    charCount: text.length,
  };
}

/**
 * Cleans text for quote display: collapses whitespace, trims.
 */
export function cleanQuoteText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}
