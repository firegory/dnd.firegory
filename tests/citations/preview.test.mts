import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_PREVIEW_PAGE,
  PREVIEW_WIDTH_PX,
  CitationPreviewInputError,
  citationPreviewCachePath,
  parseCitationPreviewRequest,
} from "../../src/server/citations/preview.ts";

const sourceId = "11111111-1111-4111-8111-111111111111";
const fileId = "22222222-2222-4222-8222-222222222222";

test("parseCitationPreviewRequest accepts source, file, and page", () => {
  const input = parseCitationPreviewRequest(
    new URL(`https://example.test/api/citations/preview?sourceId=${sourceId}&fileId=${fileId}&page=42`),
  );

  assert.deepEqual(input, { sourceId, fileId, page: 42 });
});

test("parseCitationPreviewRequest rejects invalid identifiers and page bounds", () => {
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=nope&fileId=${fileId}&page=1`)),
    CitationPreviewInputError,
  );
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=${sourceId}&fileId=${fileId}&page=0`)),
    CitationPreviewInputError,
  );
  assert.throws(
    () => parseCitationPreviewRequest(new URL(`https://example.test/?sourceId=${sourceId}&fileId=${fileId}&page=${MAX_PREVIEW_PAGE + 1}`)),
    CitationPreviewInputError,
  );
});

test("citationPreviewCachePath uses processed artifacts and page-level cache naming", () => {
  assert.equal(
    citationPreviewCachePath({ sourceId, fileId, page: 7, artifactsRoot: "/tmp/artifacts" }),
    `/tmp/artifacts/previews/page-7-w${PREVIEW_WIDTH_PX}.png`,
  );
});
