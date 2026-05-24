/**
 * Bounding-box extraction from PDF using pdftotext -bbox-layout.
 *
 * Parses the HTML-like output of `pdftotext -bbox-layout` to extract
 * per-word coordinates (in PDF points, 72 DPI). Then maps chunk
 * text_span_start/end to word positions to compute a per-chunk bbox.
 *
 * The output format from pdftotext -bbox-layout is:
 * <doc>
 *   <page width="W" height="H">
 *     <flow>
 *       <block xMin="..." yMin="..." xMax="..." yMax="...">
 *         <line ...>
 *           <word xMin="..." yMin="..." xMax="..." yMax="...">text</word>
 *         </line>
 *       </block>
 *     </flow>
 *   </page>
 * </doc>
 */

import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);

const PDFTOTEXT_PATH = process.env.PDFTOTEXT_PATH ?? "pdftotext";

export type WordBbox = Readonly<{
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  text: string;
}>;

export type PageBboxes = Readonly<{
  pageNumber: number;
  width: number;
  height: number;
  words: readonly WordBbox[];
}>;

export type ChunkBbox = Readonly<{
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}>;

/**
 * Extracts per-page word bounding boxes from a PDF using pdftotext -bbox-layout.
 */
export async function extractPageBboxes(
  pdfPath: string,
  totalPages: number,
): Promise<Map<number, PageBboxes>> {
  const result = new Map<number, PageBboxes>();

  for (let page = 1; page <= totalPages; page++) {
    try {
      const bboxHtml = await runBboxLayout(pdfPath, page);
      const parsed = parseBboxHtml(bboxHtml, page);
      if (parsed) {
        result.set(page, parsed);
      }
    } catch {
      // Skip pages where bbox extraction fails
    }
  }

  return result;
}

async function runBboxLayout(pdfPath: string, page: number): Promise<string> {
  const { stdout } = await execFile(PDFTOTEXT_PATH, [
    "-bbox-layout",
    "-f", String(page),
    "-l", String(page),
    "-enc", "UTF-8",
    pdfPath,
    "-",
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/**
 * Parses the bbox-layout HTML output for a single page.
 *
 * We use simple string parsing instead of a full HTML parser to avoid
 * adding dependencies. The output is well-structured and predictable.
 */
export function parseBboxHtml(html: string, pageNumber: number): PageBboxes | null {
  const pageMatch = html.match(/<page\b[^>]*>/);
  if (!pageMatch) return null;

  const pageTag = pageMatch[0];
  const widthAttr = pageTag.match(/width="([\d.]+)"/);
  const heightAttr = pageTag.match(/height="([\d.]+)"/);
  if (!widthAttr || !heightAttr) return null;

  const width = parseFloat(widthAttr[1]);
  const height = parseFloat(heightAttr[1]);

  const words: WordBbox[] = [];

  const wordRegex = /<word\b([^>]*)>([\s\S]*?)<\/word>/g;
  let m: RegExpExecArray | null;

  while ((m = wordRegex.exec(html)) !== null) {
    const attrs = m[1];
    const text = unescapeHtml(m[2]);
    if (!text.trim()) continue;

    const xMin = parseFloat(attrs.match(/xMin="([\d.]+)"/)?.[1] ?? "0");
    const yMin = parseFloat(attrs.match(/yMin="([\d.]+)"/)?.[1] ?? "0");
    const xMax = parseFloat(attrs.match(/xMax="([\d.]+)"/)?.[1] ?? "0");
    const yMax = parseFloat(attrs.match(/yMax="([\d.]+)"/)?.[1] ?? "0");

    words.push({ xMin, yMin, xMax, yMax, text });
  }

  return { pageNumber, width, height, words };
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Builds a concatenated text from all words on a page (matching the order
 * pdftotext -layout would produce), then maps chunk span offsets to compute
 * the bounding box for each chunk.
 *
 * Returns a Map from chunkIndex to ChunkBbox.
 */
export function computeChunkBboxes(
  pageBboxes: PageBboxes,
  chunksOnPage: readonly Readonly<{
    chunkIndex: number;
    textSpanStart: number;
    textSpanEnd: number;
    text: string;
  }>[],
): Map<number, ChunkBbox> {
  const result = new Map<number, ChunkBbox>();

  if (pageBboxes.words.length === 0 || chunksOnPage.length === 0) {
    return result;
  }

  for (const chunk of chunksOnPage) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;

    const bbox = matchChunkToWords(
      pageBboxes.words,
      chunk.textSpanStart,
      chunk.textSpanEnd,
    );

    if (bbox) {
      result.set(chunk.chunkIndex, bbox);
    }
  }

  return result;
}

/**
 * Given the full concatenated page text and word positions, find the words
 * that fall within [spanStart, spanEnd] and compute their bounding box.
 */
function matchChunkToWords(
  words: readonly WordBbox[],
  spanStart: number,
  spanEnd: number,
): ChunkBbox | null {
  // Build character offsets for each word in the concatenated text
  let charPos = 0;
  const wordPositions: Array<{ start: number; end: number; bbox: WordBbox }> = [];

  for (const word of words) {
    const start = charPos;
    const end = charPos + word.text.length;
    wordPositions.push({ start, end, bbox: word });
    charPos = end + 1; // +1 for the space between words
  }

  // Find words that overlap with the chunk's span
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  let found = false;

  for (const wp of wordPositions) {
    // Check if this word overlaps with the chunk span
    if (wp.end <= spanStart || wp.start >= spanEnd) continue;

    x1 = Math.min(x1, wp.bbox.xMin);
    y1 = Math.min(y1, wp.bbox.yMin);
    x2 = Math.max(x2, wp.bbox.xMax);
    y2 = Math.max(y2, wp.bbox.yMax);
    found = true;
  }

  if (!found) return null;

  return { x1, y1, x2, y2 };
}
