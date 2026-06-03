import type { SourceCitation } from "../rag/format";

const TG_MAX_LENGTH = 4096;

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
      const addition = `\n${i + 1}. ${source}`;

      if (msg.length + addition.length > TG_MAX_LENGTH - 100) {
        parts.push(msg);
        msg = `<b>Sources (continued)</b>${addition}`;
      } else {
        msg += addition;
      }
    }
  }

  if (msg.trim()) {
    parts.push(msg);
  }

  return parts.length > 0 ? parts : ["No answer generated."];
}

function formatCitation(c: SourceCitation): string {
  let text = `"<i>${escapeHtml(truncate(c.quote, 200))}</i>"`;

  const meta: string[] = [];
  if (c.sourceTitle && c.sourceTitle !== "Unknown") {
    meta.push(escapeHtml(c.sourceTitle));
  }
  if (c.edition) meta.push(c.edition);
  if (c.page != null) meta.push(`p.${c.page}`);
  if (c.section) meta.push(escapeHtml(c.section));

  if (meta.length > 0) {
    text += `\n   — ${meta.join(", ")}`;
  }

  return text;
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
