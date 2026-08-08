import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { PublicationCommand } from "../../src/server/content-storage/publication-command.ts";
import { createCanonicalRevision, formatPublicationGeneration, type CanonicalRevision, type CanonicalRevisionInput } from "../../src/server/content-storage/repository.ts";
import { loadResolvedRepositoryManifest } from "../../src/server/content-storage/validation.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const childScript = resolve(projectRoot, "tests/qa/publication-process-child.mts");

test("QA integration: SIGKILL before activation rename never exposes a partial release and retry activates", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-publication-process-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = resolve(parent, "repository");
  await cp(resolve(projectRoot, "content-repository"), root, { recursive: true });
  const before = await loadResolvedRepositoryManifest(root);
  const active = before.manifest.entries[0];
  assert.ok(active);
  const current = JSON.parse(await readFile(resolve(root, active.path), "utf8")) as CanonicalRevision;
  const input = structuredClone(current) as Partial<CanonicalRevision>;
  delete input.revisionId;
  delete input.contentHash;
  const revision = createCanonicalRevision({ ...input, createdAt: "2026-08-08T13:00:00.000Z" } as CanonicalRevisionInput);
  const command: PublicationCommand = {
    schemaVersion: 2,
    kind: "publishCanonicalRevision",
    idempotencyKey: "qa-process-crash",
    generation: formatPublicationGeneration(1n),
    expectedActiveRevisionId: active.revisionId,
    revision,
  };
  const commandPath = resolve(parent, "command.json");
  await writeFile(commandPath, JSON.stringify(command));

  const crashing = child(root, commandPath, "crash");
  await childMessage(crashing, "activation-temporary-synced");
  assert.equal(crashing.kill("SIGKILL"), true);
  await childExit(crashing);
  assert.equal((await loadResolvedRepositoryManifest(root)).manifest.entries[0]?.revisionId, active.revisionId);

  const retry = child(root, commandPath, "retry");
  await childMessage(retry, "completed");
  await childExit(retry);
  assert.equal((await loadResolvedRepositoryManifest(root)).manifest.entries[0]?.revisionId, revision.revisionId);
});

function child(root: string, commandPath: string, mode: "crash" | "retry"): ChildProcess {
  return fork(childScript, [root, commandPath, mode], { execArgv: ["--experimental-strip-types"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
}

function childMessage(childProcess: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => reject(new Error(`child did not report ${expected}`)), 10_000);
    childProcess.on("error", reject);
    childProcess.on("exit", (code, signal) => reject(new Error(`child exited before ${expected}: ${signal ?? code}`)));
    childProcess.on("message", (message) => {
      if (message !== expected) return;
      clearTimeout(timeout);
      resolveMessage();
    });
  });
}

function childExit(childProcess: ChildProcess): Promise<void> {
  if (childProcess.exitCode !== null || childProcess.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => reject(new Error("child did not exit")), 10_000);
    childProcess.once("error", reject);
    childProcess.once("exit", () => { clearTimeout(timeout); resolveExit(); });
  });
}
