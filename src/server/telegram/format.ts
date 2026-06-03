import type { SourceCitation } from "../rag/format";

const TG_MAX_LENGTH = 4096;
const TG_MARGIN = 100;

export function formatAnswer(
  answer: string,
  citations: readonly SourceCitation[],
): string[] {
  const parts: string[] = [];

  let msg = `<b>Answer</b>\n${escapeHtml(answer)}`;

  if (citations.length > 0) {
    msg += "\n\n<b>Sources:</b>";
    for (let i = 0; i < citations.length; i++) {
      const c = citations[i];
      const source = formatCitation(c);
      const addition = `\n\n${source}`;

      if (msg.length + addition.length > TG_MAX_LENGTH - TG_MARGIN) {
        parts.push(closeOpenTags(msg));
        msg = `<b>Sources (continued)</b>${addition}`;
      } else {
        msg += addition;
      }
    }
  }

  if (msg.trim()) {
    parts.push(closeOpenTags(msg));
  }

  return parts.length > 0 ? parts : ["No answer generated."];
}

function closeOpenTags(msg: string): string {
  const openCount = countOccurrences(msg, "<blockquote>");
  const closeCount = countOccurrences(msg, "</blockquote>");
  for (let i = 0; i < openCount - closeCount; i++) {
    msg += "</blockquote>";
  }
  return msg;
}

function countOccurrences(str: string, substr: string): number {
  let count = 0;
  let pos = 0;
  while ((pos = str.indexOf(substr, pos)) !== -1) {
    count++;
    pos += substr.length;
  }
  return count;
}

function formatCitation(c: SourceCitation): string {
  const quote = truncate(c.quote, 200);

  const meta: string[] = [];
  if (c.sourceTitle && c.sourceTitle !== "Unknown") {
    meta.push(escapeHtml(c.sourceTitle));
  }
  if (c.edition) meta.push(c.edition);
  if (c.page != null) meta.push(`p.${c.page}`);
  if (c.section) meta.push(escapeHtml(c.section));

  const metaLine = meta.length > 0 ? `\n— ${meta.join(", ")}` : "";

  return `<blockquote>${escapeHtml(quote)}${metaLine}</blockquote>`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}
