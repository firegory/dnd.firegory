import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../../src/app/favicon.ico/route.ts";

test("direct favicon route returns a cacheable self-contained image", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const image = await response.text();
  assert.match(image, /^<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.doesNotMatch(image, /(?:href|src)=/);
});
