import { CitationPreviewError, type CitationPreviewErrorCode } from "./preview.ts";

type PreviewErrorBody = Readonly<{
  error: string;
  code: CitationPreviewErrorCode;
  detail?: string;
}>;

export function citationPreviewHttpError(error: unknown): { status: number; body: PreviewErrorBody } {
  const code = error instanceof CitationPreviewError ? error.code : "render_failed";
  if (code === "page_not_found") {
    return { status: 404, body: { error: "Citation preview not found.", code } };
  }
  const status = code === "render_timeout" ? 504 : 503;
  const detail = code === "source_file_missing"
    ? "Original PDF is unavailable."
    : code === "renderer_unavailable"
      ? "PDF preview renderer is unavailable."
      : "PDF preview could not be rendered.";
  return { status, body: { error: "Citation preview is unavailable.", code, detail } };
}

export function logCitationPreviewError(error: unknown, context: Record<string, string | number>): void {
  const code = error instanceof CitationPreviewError ? error.code : "render_failed";
  console.error(JSON.stringify({ event: "citation_preview_failed", code, ...context }));
}
