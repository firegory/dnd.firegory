import assert from "node:assert/strict";
import test from "node:test";

import { ContentMetadataValidationError } from "../../src/server/content/metadata.ts";
import { mapContentMetadataHttpError } from "../../src/server/content/metadata-http.ts";

test("source PATCH route maps publication validation failures to HTTP 400", async () => {
  const response = mapContentMetadataHttpError(
    new ContentMetadataValidationError("publication must be a non-null object."),
  );

  assert.deepEqual(response, {
    status: 400,
    body: { error: "publication must be a non-null object." },
  });
});
