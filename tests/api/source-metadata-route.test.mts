import assert from "node:assert/strict";
import test from "node:test";

import { ContentMetadataConflictError, ContentMetadataValidationError } from "../../src/server/content/metadata.ts";
import { mapContentMetadataHttpError } from "../../src/server/content/metadata-http.ts";
import {
  SOURCE_ARCHIVE_ERROR_CODES,
  SourceArchiveError,
  archiveSourceWithClient,
  mapSourceArchiveError,
} from "../../src/server/content/source-lifecycle.ts";

test("source PATCH route maps publication validation failures to HTTP 400", async () => {
  const response = mapContentMetadataHttpError(
    new ContentMetadataValidationError("publication must be a non-null object."),
  );

  assert.deepEqual(response, {
    status: 400,
    body: { error: "publication must be a non-null object." },
  });
});

test("source metadata route maps archived-source write conflicts to HTTP 409", () => {
  assert.deepEqual(
    mapContentMetadataHttpError(new ContentMetadataConflictError("Source is archived.")),
    { status: 409, body: { error: "Source is archived." } },
  );
});

test("source archive route contract requires an explicit confirmation title", async () => {
  await assert.rejects(
    () => archiveSourceWithClient({ query: async () => assert.fail("database must not be queried") } as never, "source-1", undefined as never),
    (error: unknown) => {
      assert.ok(error instanceof SourceArchiveError);
      assert.deepEqual(mapSourceArchiveError(error), {
        status: 400,
        body: {
          error: "confirmationTitle is required.",
          code: SOURCE_ARCHIVE_ERROR_CODES.titleRequired,
        },
      });
      return true;
    },
  );
});
