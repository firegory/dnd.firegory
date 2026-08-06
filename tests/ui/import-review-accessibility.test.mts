import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile("src/app/admin/compendium/imports/[runId]/review-client.tsx", "utf8");

test("candidate controls and citation feedback include candidate-specific accessible text", () => {
  assert.match(source, /aria-label=.*candidate\.candidateKey/);
  assert.match(source, /alt=.*candidateKey.*page/);
  assert.match(source, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(source, /role="alert"/);
  assert.match(source, /candidatePreviewFailed.*candidate: candidateKey/);
  assert.match(source, /activeRevisionToken/);
  assert.match(source, /Object\.fromEntries\(candidateIds\.map/);
});
