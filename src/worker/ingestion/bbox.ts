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

import { PDF_TOOL_TIMEOUT_MS, TOOL_STDIO_MAX_BYTES } from "../../server/ingestion/limits.ts";
import { runMonitoredTool } from "./tool-runner.ts";

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
  const { stdout } = await runMonitoredTool(PDFTOTEXT_PATH, [
    "-bbox-layout",
    "-f", String(page),
    "-l", String(page),
    "-enc", "UTF-8",
    pdfPath,
    "-",
  ], {
    maxStdoutBytes: TOOL_STDIO_MAX_BYTES,
    timeoutMs: PDF_TOOL_TIMEOUT_MS,
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

  const allWordsText = pageBboxes.words.map((w) => w.text.toLowerCase());

  for (const chunk of chunksOnPage) {
    const chunkText = chunk.text.trim();
    if (!chunkText) continue;

    const bbox = matchChunkByText(pageBboxes.words, allWordsText, chunkText);

    if (bbox) {
      result.set(chunk.chunkIndex, bbox);
    }
  }

  return result;
}

function matchChunkByText(
  words: readonly WordBbox[],
  allWordsText: readonly string[],
  chunkText: string,
): ChunkBbox | null {
  const chunkLower = chunkText.toLowerCase();
  const chunkTokens = chunkLower.split(/\s+/).filter(Boolean);
  if (chunkTokens.length === 0) return null;

  const probeLen = Math.min(chunkTokens.length, 4);
  const probe = chunkTokens.slice(0, probeLen);

  let bestStart = -1;

  for (let i = 0; i <= allWordsText.length - probeLen; i++) {
    let match = true;
    for (let j = 0; j < probeLen; j++) {
      if (allWordsText[i + j] !== probe[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      bestStart = i;
      break;
    }
  }

  if (bestStart === -1) {
    for (let i = 0; i <= allWordsText.length - probeLen; i++) {
      let match = true;
      for (let j = 0; j < probeLen; j++) {
        if (!allWordsText[i + j].includes(probe[j]) && !probe[j].includes(allWordsText[i + j])) {
          match = false;
          break;
        }
      }
      if (match) {
        bestStart = i;
        break;
      }
    }
  }

  if (bestStart === -1) return null;

  let matchEnd = bestStart + probeLen;
  for (let i = matchEnd; i < allWordsText.length && i < bestStart + chunkTokens.length + 5; i++) {
    const tailTokens = chunkTokens.slice(matchEnd - bestStart);
    if (tailTokens.length === 0) break;
    if (allWordsText[i] === tailTokens[0]) {
      matchEnd = i + 1;
    } else {
      break;
    }
  }

  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;

  for (let i = bestStart; i < matchEnd && i < words.length; i++) {
    x1 = Math.min(x1, words[i].xMin);
    y1 = Math.min(y1, words[i].yMin);
    x2 = Math.max(x2, words[i].xMax);
    y2 = Math.max(y2, words[i].yMax);
  }

  if (!isFinite(x1)) return null;

  return { x1, y1, x2, y2 };
}
