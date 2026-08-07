import assert from "node:assert/strict";
import test from "node:test";

import { copiesWholeBuildContext, copyInstructions, parseDockerfile, requireDockerStage } from "./dockerfile.mts";

const broadCopyFixtures = [
  "COPY . /app",
  "COPY ./ /app",
  "COPY --chown=10001:10001 . /app",
  "ADD . /app",
  'COPY [".", "/app"]',
  'COPY --chown=10001:10001 ["./", "/app"]',
  ["COPY --chown=10001:10001 \\", "./ \\", "/app"].join("\n"),
];

test("Dockerfile parser detects broad context copies across equivalent forms", () => {
  for (const fixture of broadCopyFixtures) {
    const stage = requireDockerStage(parseDockerfile(`FROM node:22 AS app\n${fixture}`), "app");
    assert.equal(copyInstructions(stage).some(copiesWholeBuildContext), true, fixture);
  }
});

test("Dockerfile parser ignores comments and preserves hashes inside instructions", () => {
  const dockerfile = parseDockerfile(`
    # COPY . /app
    FROM node:22 AS app
    # ADD [".", "/app"]
    RUN printf '# COPY --chown=1000:1000 . /app'
    COPY package.json /app/
  `);
  const stage = requireDockerStage(dockerfile, "app");
  assert.deepEqual(copyInstructions(stage), [{
    keyword: "COPY",
    options: {},
    sources: ["package.json"],
    destination: "/app/",
  }]);
  assert.equal(stage.instructions.find((instruction) => instruction.keyword === "RUN")?.value, "printf '# COPY --chown=1000:1000 . /app'");
});

test("Dockerfile parser joins continuations and parses copy options and operands", () => {
  const fixture = [
    "FROM node:22 AS app",
    "COPY --from=builder \\",
    "# a comment between continued operands",
    "--chown=10001:10001 \\",
    "/app/.next/standalone ./",
  ].join("\n");
  const stage = requireDockerStage(parseDockerfile(fixture), "app");
  assert.deepEqual(copyInstructions(stage), [{
    keyword: "COPY",
    options: { from: "builder", chown: "10001:10001" },
    sources: ["/app/.next/standalone"],
    destination: "./",
  }]);
});

test("Dockerfile parser keeps instructions within real stage boundaries", () => {
  const dockerfile = parseDockerfile(`
    # FROM scratch AS ignored
    FROM node:22 AS app
    COPY package.json ./
    FROM node:22 AS worker
    ADD worker.ts ./
  `);
  assert.deepEqual(dockerfile.stages.map((stage) => stage.name), ["app", "worker"]);
  assert.deepEqual(copyInstructions(requireDockerStage(dockerfile, "app")).map((copy) => copy.sources), [["package.json"]]);
  assert.deepEqual(copyInstructions(requireDockerStage(dockerfile, "worker")).map((copy) => copy.sources), [["worker.ts"]]);
});
