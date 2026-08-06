import assert from "node:assert/strict";
import test from "node:test";

import { parseImportReviewActionRequest } from "../../src/server/compendium/import-review-http.ts";
import { assertSameOriginMutation, OriginValidationError } from "../../src/server/http/same-origin.ts";

const first = "11111111-1111-4111-8111-111111111111";
const second = "22222222-2222-4222-8222-222222222222";

test("review action payload rejects unknown, mixed, duplicate, and malformed optional fields", () => {
  const invalid = [
    null,
    { action: "approve", candidateIds: [first], extra: true },
    { action: "unknown", candidateIds: [first] },
    { action: "approve", candidateIds: [first, 42] },
    { action: "approve", candidateIds: [first, first] },
    { action: "approve", candidateIds: [first], resolvedContent: {} },
    { action: "merge", candidateIds: [first] },
    { action: "merge", candidateIds: [first], resolvedContent: null },
    { action: "merge", candidateIds: [first, second], resolvedContent: {} },
    { action: "merge", candidateIds: [first, second], resolvedContents: { [first]: {} } },
    { action: "merge", candidateIds: [first], resolvedContent: {}, resolvedContents: { [first]: {} } },
  ];
  for (const value of invalid) assert.throws(() => parseImportReviewActionRequest(value));
  assert.deepEqual(parseImportReviewActionRequest({ action: "approve", candidateIds: [first] }), { action: "approve", candidateIds: [first] });
  assert.deepEqual(parseImportReviewActionRequest({ action: "merge", candidateIds: [first], resolvedContent: { entry: {} } }), { action: "merge", candidateIds: [first], resolvedContent: { entry: {} } });
});

test("review mutations require an exact same-origin Origin header", () => {
  const request = (origin?: string) => new Request("https://dnd.example/api/admin/compendium/import-runs/run/actions", {
    method: "POST",
    headers: origin ? { Origin: origin } : {},
  });
  assert.doesNotThrow(() => assertSameOriginMutation(request("https://dnd.example")));
  assert.throws(() => assertSameOriginMutation(request()), OriginValidationError);
  assert.throws(() => assertSameOriginMutation(request("https://evil.example")), /Cross-origin/);
  assert.throws(() => assertSameOriginMutation(request("null")), OriginValidationError);
  assert.throws(() => assertSameOriginMutation(request("https://dnd.example/extra")), OriginValidationError);
});
