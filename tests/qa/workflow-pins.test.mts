import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { parse } from "yaml";

const source = await readFile(".github/workflows/compendium-qa.yml", "utf8");
const workflow = parse(source) as { jobs: { qa: { services: { postgres: { image: string } }; steps: Array<{ uses?: string; run?: string }> } } };
const image = JSON.parse(await readFile("tests/fixtures/pgvector-0.8.1-pg16-image.json", "utf8")) as {
  image: string; indexDigest: string; platforms: Array<{ os: string; architecture: string }>;
};

test("QA workflow pins every action and the verified multi-architecture pgvector index", () => {
  const qa = workflow.jobs.qa;
  for (const step of qa.steps.filter((candidate) => candidate.uses)) {
    assert.match(step.uses!, /^[a-z0-9_.-]+\/[a-z0-9_.-]+@[0-9a-f]{40}$/i);
  }
  assert.equal(qa.services.postgres.image, `${image.image}@${image.indexDigest}`);
  assert.ok(image.platforms.some(({ os, architecture }) => os === "linux" && architecture === "amd64"));
  assert.ok(image.platforms.some(({ os, architecture }) => os === "linux" && architecture === "arm64"));
});

test("QA artifacts are initialized early and auth state is never uploaded", () => {
  const runs = workflow.jobs.qa.steps.map(({ run }) => run ?? "").join("\n");
  assert.match(runs, /mkdir -p qa-artifacts\/diagnostics playwright-report test-results\/results/);
  assert.doesNotMatch(source, /test-results\/auth|dnd-firegory-qa-auth.*upload/);
  assert.match(source, /if-no-files-found: warn/);
});
