import assert from "node:assert/strict";
import { chmod, cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadPublicationCommand,
  submitPublicationCommand,
  type PublicationCommand,
} from "../../src/server/content-storage/publication-command.ts";
import {
  createCanonicalRevision,
  manifestPath,
  publicationSpoolPath,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type RepositoryManifest,
} from "../../src/server/content-storage/repository.ts";
import { validateContentRepository } from "../../src/server/content-storage/validation.ts";
import { RedisPublicationLeaseManager } from "../../src/worker/publication/lease.ts";
import {
  PublicationLeaseUnavailableError,
  publishCanonicalRevision,
} from "../../src/worker/publication/publisher.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(projectRoot, "content-repository");

test("app submission writes only a durable spool command and safely requeues the same key", async (t) => {
  const root = await temporaryRepository(t);
  const spoolRoot = resolve(dirname(root), "spool");
  const revision = await nextRevision(root, "2026-08-06T01:00:00.000Z");
  const manifestBefore = await readFile(manifestPath(root), "utf8");
  const queued: string[] = [];
  await chmod(root, 0o555);

  const first = await submitPublicationCommand(
    { idempotencyKey: "publish-dash-v2", revision },
    { spoolRoot, enqueue: async (key) => { queued.push(key); } },
  );
  const retry = await submitPublicationCommand(
    { idempotencyKey: "publish-dash-v2", revision },
    { spoolRoot, enqueue: async (key) => { queued.push(key); } },
  );

  assert.equal(first.existing, false);
  assert.equal(retry.existing, true);
  assert.deepEqual(queued, ["publish-dash-v2", "publish-dash-v2"]);
  assert.deepEqual((await loadPublicationCommand("publish-dash-v2", spoolRoot)).revision, revision);
  assert.equal(await readFile(manifestPath(root), "utf8"), manifestBefore);
  assert.equal(publicationSpoolPath(spoolRoot, "publish-dash-v2"), first.commandPath);
  assert.throws(() => publicationSpoolPath(spoolRoot, "../escape"), /stable ID/);

  const conflicting = await nextRevision(root, "2026-08-06T02:00:00.000Z");
  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "publish-dash-v2", revision: conflicting },
      { spoolRoot, enqueue: async () => undefined },
    ),
    /already bound to another publication/,
  );
});

test("crash before activation preserves the old manifest and retry activates once", async (t) => {
  const root = await temporaryRepository(t);
  const oldManifest = await readManifest(root);
  const revision = await nextRevision(root, "2026-08-06T03:00:00.000Z");
  const command = publicationCommand("publish-dash-crash", revision);
  const leaseManager = new RedisPublicationLeaseManager(memoryLeaseCommands());

  await assert.rejects(
    publishCanonicalRevision({
      dataRoot: root,
      command,
      leaseManager,
      hooks: { beforeActivation: () => { throw new Error("simulated process crash"); } },
    }),
    /simulated process crash/,
  );

  assert.deepEqual(await readManifest(root), oldManifest);
  await validateContentRepository(root);

  const retry = await publishCanonicalRevision({ dataRoot: root, command, leaseManager });
  assert.equal(retry.alreadyActive, false);
  assert.equal((await readManifest(root)).entries[0].revisionId, revision.revisionId);

  const duplicate = await publishCanonicalRevision({ dataRoot: root, command, leaseManager });
  assert.equal(duplicate.alreadyActive, true);
  const revisionFiles = await readdir(resolve(root, "compendium/dash/revisions"));
  assert.equal(revisionFiles.filter((name) => name === `${revision.revisionId}.json`).length, 1);
  await validateContentRepository(root);
});

test("concurrent publication jobs never overlap their canonical write phases", async (t) => {
  const root = await temporaryRepository(t);
  const leaseManager = new RedisPublicationLeaseManager(memoryLeaseCommands());
  const firstRevision = await nextRevision(root, "2026-08-06T04:00:00.000Z");
  const secondRevision = await nextRevision(root, "2026-08-06T05:00:00.000Z");
  let releaseFirst!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { releaseFirst = resolveBlocked; });
  let enteredFirst!: () => void;
  const firstEntered = new Promise<void>((resolveEntered) => { enteredFirst = resolveEntered; });
  let active = 0;
  let maximumActive = 0;

  const first = publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("publish-dash-concurrent-a", firstRevision),
    leaseManager,
    hooks: {
      onCanonicalPhase(value) {
        active += value ? 1 : -1;
        maximumActive = Math.max(maximumActive, active);
        if (value) enteredFirst();
      },
      beforeActivation: () => blocked,
    },
  });
  await firstEntered;

  await assert.rejects(
    publishCanonicalRevision({
      dataRoot: root,
      command: publicationCommand("publish-dash-concurrent-b", secondRevision),
      leaseManager,
      hooks: { onCanonicalPhase: (value) => { active += value ? 1 : -1; } },
    }),
    PublicationLeaseUnavailableError,
  );
  assert.equal(maximumActive, 1);
  releaseFirst();
  await first;
  assert.equal(active, 0);
});

test("publication rejects revisions whose source evidence is not canonical", async (t) => {
  const root = await temporaryRepository(t);
  const manifestBefore = await readManifest(root);
  const revision = await nextRevision(root, "2026-08-06T06:00:00.000Z");
  const input = structuredClone(revision) as Partial<CanonicalRevision>;
  delete input.revisionId;
  delete input.contentHash;
  input.source = { ...revision.source, title: "Unpublished source metadata" };
  const mismatched = createCanonicalRevision(input as CanonicalRevisionInput);

  await assert.rejects(
    publishCanonicalRevision({
      dataRoot: root,
      command: publicationCommand("publish-mismatched-source", mismatched),
      leaseManager: new RedisPublicationLeaseManager(memoryLeaseCommands()),
    }),
    /source provenance does not match/,
  );
  assert.deepEqual(await readManifest(root), manifestBefore);
});

test("an expired lease is recoverable and stale owners cannot renew or release it", async () => {
  let now = 0;
  const commands = memoryLeaseCommands(() => now);
  const manager = new RedisPublicationLeaseManager(commands);
  const first = await manager.acquire("repository-one", 100);
  assert.ok(first);
  assert.equal(await manager.acquire("repository-one", 100), null);

  now = 101;
  const recovered = await manager.acquire("repository-one", 100);
  assert.ok(recovered);
  assert.equal(await first.renew(), false);
  assert.equal(await first.release(), false);
  assert.equal(await recovered.renew(), true);
  assert.equal(await recovered.release(), true);
});

async function temporaryRepository(t: TestContext): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "dnd-publication-"));
  const root = resolve(parent, "repository");
  await cp(fixtureRoot, root, { recursive: true });
  t.after(async () => {
    await chmod(root, 0o755).catch(() => undefined);
    await rm(parent, { recursive: true, force: true });
  });
  return root;
}

async function readManifest(root: string): Promise<RepositoryManifest> {
  return JSON.parse(await readFile(manifestPath(root), "utf8")) as RepositoryManifest;
}

async function nextRevision(root: string, createdAt: string): Promise<CanonicalRevision> {
  const manifest = await readManifest(root);
  const current = JSON.parse(await readFile(resolve(root, manifest.entries[0].path), "utf8")) as CanonicalRevision;
  const input = structuredClone(current) as Partial<CanonicalRevision>;
  delete input.revisionId;
  delete input.contentHash;
  input.createdAt = createdAt;
  return createCanonicalRevision(input as CanonicalRevisionInput);
}

function publicationCommand(idempotencyKey: string, revision: CanonicalRevision): PublicationCommand {
  return { schemaVersion: 1, kind: "publishCanonicalRevision", idempotencyKey, revision };
}

function memoryLeaseCommands(now: () => number = Date.now) {
  const leases = new Map<string, { ownerId: string; expiresAt: number }>();
  return {
    async acquire(key: string, ownerId: string, ttlMs: number) {
      const current = leases.get(key);
      if (current && current.expiresAt > now()) return false;
      leases.set(key, { ownerId, expiresAt: now() + ttlMs });
      return true;
    },
    async renew(key: string, ownerId: string, ttlMs: number) {
      const current = leases.get(key);
      if (!current || current.ownerId !== ownerId || current.expiresAt <= now()) return false;
      current.expiresAt = now() + ttlMs;
      return true;
    },
    async release(key: string, ownerId: string) {
      const current = leases.get(key);
      if (!current || current.ownerId !== ownerId || current.expiresAt <= now()) return false;
      leases.delete(key);
      return true;
    },
  };
}
