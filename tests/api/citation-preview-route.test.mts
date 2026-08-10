import assert from "node:assert/strict";
import test from "node:test";

import { CitationPreviewError } from "../../src/server/citations/preview.ts";
import { citationPreviewHttpError, logCitationPreviewError } from "../../src/server/citations/preview-http.ts";

test("citation preview route maps typed failures without exposing filesystem paths", async () => {
  const messages: string[] = [];
  const originalError = console.error;
  console.error = (message?: unknown) => messages.push(String(message));
  try {
    const missingError = new CitationPreviewError("source_file_missing");
    logCitationPreviewError(missingError, { kind: "page", sourceId: "source-id", fileId: "file-id", page: 7 });
    const missing = citationPreviewHttpError(missingError);
    assert.equal(missing.status, 503);
    assert.deepEqual(missing.body, {
      error: "Citation preview is unavailable.",
      code: "source_file_missing",
      detail: "Original PDF is unavailable.",
    });

    const invalidPageError = new CitationPreviewError("page_not_found");
    logCitationPreviewError(invalidPageError, { kind: "page", page: 99 });
    const invalidPage = citationPreviewHttpError(invalidPageError);
    assert.equal(invalidPage.status, 404);
    assert.deepEqual(invalidPage.body, { error: "Citation preview not found.", code: "page_not_found" });

    const timeoutError = new CitationPreviewError("render_timeout");
    logCitationPreviewError(timeoutError, { kind: "chunk", chunkId: "chunk-id" });
    const timeout = citationPreviewHttpError(timeoutError);
    assert.equal(timeout.status, 504);
    assert.equal(timeout.body.code, "render_timeout");

    assert.equal(messages.length, 3);
    for (const message of messages) {
      const log = JSON.parse(message);
      assert.equal(log.event, "citation_preview_failed");
      assert.doesNotMatch(message, /\/app\/storage|secret\.pdf/);
    }
  } finally {
    console.error = originalError;
  }
});
