import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("package and operator/agent docs expose the same seed boundaries and commands", async () => {
  const [pkg, operator, agent, readme, qa] = await Promise.all([
    readFile("package.json", "utf8"),
    readFile("docs/corpus-seeding.md", "utf8"),
    readFile("docs/agent-gateway.md", "utf8"),
    readFile("README.md", "utf8"),
    readFile("docs/compendium-qa.md", "utf8"),
  ]);
  assert.match(pkg, /"corpus-seed": "node --experimental-strip-types scripts\/corpus-seed\.mts"/);
  for (const command of ["corpus-seed -- validate", "corpus-seed -- load", "corpus-seed -- status", "content-index -- incremental", "content-index -- backfill-embeddings"]) assert.ok(operator.includes(command), command);
  assert.match(operator, /never calls review or publication APIs/);
  assert.match(operator, /Authenticated `admin` session/);
  assert.match(operator, /Single worker identity/);
  assert.match(agent, /Agents remain read-only/);
  assert.match(agent, /Only the worker may write canonical content/);
  assert.match(readme, /docs\/corpus-seeding\.md/);
  assert.match(qa, /corpus-seed validation\/idempotency\/retry\/atomic-manifest contracts/);
});

test("approved plan enumerates every supported type and explicit exclusions", async () => {
  const plan = JSON.parse(await readFile("config/corpus-seed-2024.json", "utf8"));
  assert.deepEqual(plan.slots.map((slot: { contentType: string }) => slot.contentType).sort(), ["background", "class", "creature", "equipment", "feat", "glossary", "item", "species", "spell"]);
  assert.ok(plan.slots.every((slot: { required: boolean }) => slot.required));
  assert.ok(plan.exclusions.length >= 5);
  assert.equal(plan.sourceRequirements.licenseApprovalRequired, true);
});
