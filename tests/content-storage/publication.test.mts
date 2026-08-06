import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadPublicationCommand,
  markPublicationCompleted,
  readOutboxState,
  reconcilePublicationOutbox,
  submitPublicationCommand,
  type PublicationCommand,
} from "../../src/server/content-storage/publication-command.ts";
import {
  publicationOutboxStatePath,
  publicationQuarantinePath,
  createCanonicalRevision,
  manifestPath,
  publicationSpoolPath,
  publicationStagingPath,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type RepositoryManifest,
} from "../../src/server/content-storage/repository.ts";
import { type PublicationReservation } from "../../src/server/content-storage/publication-queue.ts";
import { validateContentRepository } from "../../src/server/content-storage/validation.ts";
import { PostgresPublicationFenceManager, type PublicationFenceManager } from "../../src/worker/publication/fence.ts";
import { RedisPublicationLeaseManager } from "../../src/worker/publication/lease.ts";
import { processPublicationReservation } from "../../src/worker/publication/processor.ts";
import {
  PublicationFenceUnavailableError,
  publishCanonicalRevision,
} from "../../src/worker/publication/publisher.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(projectRoot, "content-repository");

test("read-only app submission durably records intent and reconciliation closes enqueue crash windows", async (t) => {
  const root = await temporaryRepository(t);
  const spoolRoot = resolve(dirname(root), "spool");
  const revision = await nextRevision(root, "2026-08-06T01:00:00.000Z");
  const manifestBefore = await readFile(manifestPath(root), "utf8");
  const queued: string[] = [];
  await chmod(root, 0o555);

  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "publish-dash-v2", revision },
      {
        spoolRoot,
        now: 100,
        enqueue: async (key) => { queued.push(key); },
        afterEnqueue: () => { throw new Error("crash after enqueue"); },
      },
    ),
    /crash after enqueue/,
  );

  assert.equal((await readOutboxState(spoolRoot, "publish-dash-v2"))?.status, "pending");
  assert.deepEqual((await loadPublicationCommand("publish-dash-v2", spoolRoot)).revision, revision);
  assert.equal(await readFile(manifestPath(root), "utf8"), manifestBefore);
  assert.deepEqual(queued, ["publish-dash-v2"]);

  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 200, enqueue: async (key) => { queued.push(key); } }),
    { enqueued: 1, failed: 0 },
  );
  assert.deepEqual(queued, ["publish-dash-v2", "publish-dash-v2"]);
  assert.equal((await readOutboxState(spoolRoot, "publish-dash-v2"))?.status, "queued");

  await rm(publicationOutboxStatePath(spoolRoot, "publish-dash-v2"));
  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 300, enqueue: async (key) => { queued.push(key); } }),
    { enqueued: 1, failed: 0 },
  );
  await markPublicationCompleted("publish-dash-v2", spoolRoot, 400);
  await submitPublicationCommand(
    { idempotencyKey: "publish-dash-v2", revision },
    { spoolRoot, enqueue: async (key) => { queued.push(key); } },
  );
  assert.equal(queued.length, 3, "completed outbox entries are not redelivered by submission");
  assert.equal(publicationSpoolPath(spoolRoot, "publish-dash-v2").includes("/commands/"), true);

  const conflicting = await revisionFromFixture("2026-08-06T01:30:00.000Z");
  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "publish-dash-v2", revision: conflicting },
      { spoolRoot, enqueue: async () => undefined },
    ),
    /already bound to another publication/,
  );

  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "transient-enqueue", revision: conflicting },
      { spoolRoot, enqueue: async () => { throw new Error("Redis unavailable"); } },
    ),
    /Redis unavailable/,
  );
  assert.equal((await readOutboxState(spoolRoot, "transient-enqueue"))?.status, "pending");
  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 500, enqueue: async () => { throw new Error("still unavailable"); } }),
    { enqueued: 0, failed: 0 },
  );
  assert.equal((await readOutboxState(spoolRoot, "transient-enqueue"))?.status, "pending");

  const malformedPath = publicationSpoolPath(spoolRoot, "malformed-spool");
  await writeFile(malformedPath, "{broken");
  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 600, enqueue: async () => undefined }),
    { enqueued: 1, failed: 1 },
  );
  assert.equal((await readOutboxState(spoolRoot, "malformed-spool"))?.status, "failed");
  assert.equal(await readFile(publicationQuarantinePath(spoolRoot, "malformed-spool"), "utf8").then(Boolean), true);
});

test("database session fence prevents an expired Redis lease from enabling a stale-writer overlap", async (t) => {
  const root = await temporaryRepository(t);
  const firstRevision = await nextRevision(root, "2026-08-06T02:00:00.000Z");
  const secondRevision = await nextRevision(root, "2026-08-06T03:00:00.000Z");
  let now = 0;
  const leaseCommands = memoryLeaseCommands(() => now);
  const firstLeaseManager = new RedisPublicationLeaseManager(leaseCommands);
  const secondLeaseManager = new RedisPublicationLeaseManager(leaseCommands);
  const fenceState = { owner: null as symbol | null };
  const firstFenceManager = memoryFenceManager(fenceState);
  const secondFenceManager = memoryFenceManager(fenceState);
  let resumeFirst!: () => void;
  const pauseFirst = new Promise<void>((resolvePause) => { resumeFirst = resolvePause; });
  let firstPaused!: () => void;
  const reachedPause = new Promise<void>((resolveReached) => { firstPaused = resolveReached; });
  let active = 0;
  let maximumActive = 0;

  const first = publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("stale-writer-first", firstRevision),
    leaseManager: firstLeaseManager,
    fenceManager: firstFenceManager,
    leaseTtlMs: 100,
    hooks: {
      onCanonicalPhase(value) {
        active += value ? 1 : -1;
        maximumActive = Math.max(maximumActive, active);
      },
      beforeActivation: async () => {
        firstPaused();
        await pauseFirst;
      },
    },
  });
  await reachedPause;
  now = 101;

  await assert.rejects(
    publishCanonicalRevision({
      dataRoot: root,
      command: publicationCommand("stale-writer-second", secondRevision),
      leaseManager: secondLeaseManager,
      fenceManager: secondFenceManager,
      leaseTtlMs: 100,
    }),
    PublicationFenceUnavailableError,
  );
  assert.equal(maximumActive, 1);
  resumeFirst();
  await assert.rejects(first, /lease ownership was lost/);
  assert.equal(active, 0);

  const result = await publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("stale-writer-second", secondRevision),
    leaseManager: secondLeaseManager,
    fenceManager: secondFenceManager,
    leaseTtlMs: 100,
  });
  assert.equal(result.revisionId, secondRevision.revisionId);
  assert.equal((await readManifest(root)).entries[0].revisionId, secondRevision.revisionId);
});

test("PostgreSQL fence holds one dedicated session through verification and release", async () => {
  const queries: string[] = [];
  let releases = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      return { rows: sql.includes("pg_try_advisory_lock") ? [{ acquired: true }] : [] };
    },
    release() { releases++; },
  } as unknown as PoolClient;
  const manager = new PostgresPublicationFenceManager(async () => client);
  const fence = await manager.acquire("repository-one");
  assert.ok(fence);
  await fence.verify();
  await fence.release();

  assert.match(queries[0], /pg_try_advisory_lock/);
  assert.equal(queries[1], "SELECT 1");
  assert.match(queries[2], /pg_advisory_unlock/);
  assert.equal(releases, 1);
});

test("all pre-activation crash windows preserve the old manifest and retry cleanly", async (t) => {
  await t.test("abandoned partial unique staging temporary is removed while fenced", async (st) => {
    const root = await temporaryRepository(st);
    const revision = await nextRevision(root, "2026-08-06T04:00:00.000Z");
    const staging = publicationStagingPath(root, revision.entryId, revision.revisionId);
    await mkdir(dirname(staging), { recursive: true });
    const abandoned = resolve(dirname(staging), `.${revision.revisionId}.abandoned-worker.tmp`);
    await writeFile(abandoned, "partial");
    await publish(root, publicationCommand("partial-temporary", revision));
    await assert.rejects(readFile(abandoned), hasErrorCode("ENOENT"));
    await validateContentRepository(root);
  });

  await t.test("crash after deterministic staging leaves it invisible and resumable", async (st) => {
    const root = await temporaryRepository(st);
    const oldManifest = await readManifest(root);
    const revision = await nextRevision(root, "2026-08-06T05:00:00.000Z");
    const command = publicationCommand("staged-crash", revision);
    await assert.rejects(
      publish(root, command, { afterStagingInstalled: () => { throw new Error("staged crash"); } }),
      /staged crash/,
    );
    assert.deepEqual(await readManifest(root), oldManifest);
    assert.equal(await readFile(publicationStagingPath(root, revision.entryId, revision.revisionId), "utf8").then(Boolean), true);
    await publish(root, command);
    await validateContentRepository(root);
  });

  await t.test("crash after revision promotion leaves final revision invisible", async (st) => {
    const root = await temporaryRepository(st);
    const oldManifest = await readManifest(root);
    const revision = await nextRevision(root, "2026-08-06T06:00:00.000Z");
    const command = publicationCommand("promotion-crash", revision);
    await assert.rejects(
      publish(root, command, { beforeActivation: () => { throw new Error("promotion crash"); } }),
      /promotion crash/,
    );
    assert.deepEqual(await readManifest(root), oldManifest);
    await validateContentRepository(root);
    await publish(root, command);
    assert.equal((await publish(root, command)).alreadyActive, true);
  });

  await t.test("crash after manifest fsync but before replacement preserves old active revision", async (st) => {
    const root = await temporaryRepository(st);
    const oldManifest = await readManifest(root);
    const revision = await nextRevision(root, "2026-08-06T07:00:00.000Z");
    const command = publicationCommand("manifest-crash", revision);
    await assert.rejects(
      publish(root, command, { beforeManifestRename: () => { throw new Error("manifest crash"); } }),
      /manifest crash/,
    );
    assert.deepEqual(await readManifest(root), oldManifest);
    await publish(root, command);
    await validateContentRepository(root);
  });
});

test("canonical mutation rejects symlinked ancestors without touching outside paths", async (t) => {
  for (const directory of [".publication-staging", "compendium", "manifests"]) {
    await t.test(directory, async (st) => {
      const root = await temporaryRepository(st);
      const outside = resolve(dirname(root), `outside-${directory.replace(".", "dot")}`);
      await mkdir(outside);
      await writeFile(resolve(outside, "marker"), "unchanged");
      await rm(resolve(root, directory), { recursive: true, force: true });
      await symlink(outside, resolve(root, directory), "dir");
      const revision = await revisionFromFixture("2026-08-06T08:00:00.000Z");

      await assert.rejects(
        publish(root, publicationCommand(`symlink-${directory.replaceAll(".", "dot")}`, revision)),
        /no-follow/,
      );
      assert.deepEqual(await readdir(outside), ["marker"]);
      assert.equal(await readFile(resolve(outside, "marker"), "utf8"), "unchanged");
    });
  }
});

test("publication rejects a self-consistent revision with noncanonical source evidence", async (t) => {
  const root = await temporaryRepository(t);
  const oldManifest = await readManifest(root);
  const revision = await nextRevision(root, "2026-08-06T08:30:00.000Z");
  const input = structuredClone(revision) as Partial<CanonicalRevision>;
  delete input.revisionId;
  delete input.contentHash;
  input.source = { ...revision.source, title: "Conflicting provenance" };

  await assert.rejects(
    publish(root, publicationCommand("source-conflict", createCanonicalRevision(input as CanonicalRevisionInput))),
    /source provenance does not match/,
  );
  assert.deepEqual(await readManifest(root), oldManifest);
});

test("processor owns acknowledgements, handles duplicates, and quarantines permanent failures", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-processor-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T09:00:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "processor-duplicate", revision },
    { spoolRoot, enqueue: async () => undefined, now: 1 },
  );
  const actions = queueActionRecorder();
  let publications = 0;
  const first = reservation("delivery-first", "reservation-first", "processor-duplicate", 0);
  const duplicate = reservation("delivery-second", "reservation-second", "processor-duplicate", 0);

  assert.equal(await processPublicationReservation({
    reservation: first,
    dataRoot: "/unused",
    spoolRoot,
    now: 2,
    publish: async () => {
      publications++;
      return { entryId: "dash", revisionId: revision.revisionId, alreadyActive: false };
    },
    queue: actions.queue,
  }), "completed");
  assert.equal(await processPublicationReservation({
    reservation: duplicate,
    dataRoot: "/unused",
    spoolRoot,
    now: 3,
    publish: async () => { throw new Error("duplicate must not republish"); },
    queue: actions.queue,
  }), "already-completed");
  assert.equal(publications, 1);
  assert.deepEqual(actions.acknowledged, [first, duplicate]);

  const malformed: PublicationReservation = {
    deliveryId: "malformed-delivery",
    reservationId: "malformed-reservation",
    raw: "{broken",
    message: null,
    malformedReason: "invalid JSON",
  };
  assert.equal(await processPublicationReservation({
    reservation: malformed,
    dataRoot: "/unused",
    spoolRoot,
    now: 4,
    queue: actions.queue,
  }), "dead-lettered");
  assert.equal(JSON.parse(await readFile(publicationQuarantinePath(spoolRoot, "malformed-delivery"), "utf8")).reason, "invalid JSON");

  const missing = reservation("missing-delivery", "missing-reservation", "missing-spool", 0);
  assert.equal(await processPublicationReservation({
    reservation: missing,
    dataRoot: "/unused",
    spoolRoot,
    now: 5,
    queue: actions.queue,
  }), "dead-lettered");
  assert.equal((await readOutboxState(spoolRoot, "missing-spool"))?.status, "failed");
  assert.equal(actions.deadLettered.length, 2);
});

test("processor applies bounded exponential retry and dead-letters the final attempt", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-retries-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T10:00:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "bounded-retry", revision },
    { spoolRoot, enqueue: async () => undefined },
  );
  const actions = queueActionRecorder();
  const transient = async () => { throw new Error("temporary database outage"); };

  assert.equal(await processPublicationReservation({
    reservation: reservation("retry-one", "reservation-one", "bounded-retry", 0),
    dataRoot: "/unused",
    spoolRoot,
    now: 100,
    publish: transient,
    queue: actions.queue,
  }), "retried");
  assert.deepEqual(actions.retried[0]?.options, { now: 100, delayMs: 1_000 });

  assert.equal(await processPublicationReservation({
    reservation: reservation("retry-final", "reservation-final", "bounded-retry", 4),
    dataRoot: "/unused",
    spoolRoot,
    now: 200,
    publish: transient,
    queue: actions.queue,
  }), "dead-lettered");
  assert.equal((await readOutboxState(spoolRoot, "bounded-retry"))?.status, "failed");
});

async function publish(
  root: string,
  command: PublicationCommand,
  hooks: Parameters<typeof publishCanonicalRevision>[0]["hooks"] = {},
) {
  return publishCanonicalRevision({
    dataRoot: root,
    command,
    leaseManager: new RedisPublicationLeaseManager(memoryLeaseCommands()),
    fenceManager: memoryFenceManager({ owner: null }),
    hooks,
  });
}

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
  return revise(current, createdAt);
}

async function revisionFromFixture(createdAt: string): Promise<CanonicalRevision> {
  const manifest = await readManifest(fixtureRoot);
  const current = JSON.parse(await readFile(resolve(fixtureRoot, manifest.entries[0].path), "utf8")) as CanonicalRevision;
  return revise(current, createdAt);
}

function revise(current: CanonicalRevision, createdAt: string): CanonicalRevision {
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
      if (!current || current.ownerId !== ownerId) return false;
      leases.delete(key);
      return true;
    },
  };
}

function memoryFenceManager(state: { owner: symbol | null }): PublicationFenceManager {
  return {
    async acquire() {
      if (state.owner) return null;
      const owner = Symbol("fence-owner");
      state.owner = owner;
      return {
        async verify() {},
        async release() {
          if (state.owner === owner) state.owner = null;
        },
      };
    },
  };
}

function reservation(deliveryId: string, reservationId: string, idempotencyKey: string, attempt: number): PublicationReservation {
  const message = { deliveryId, idempotencyKey, attempt, createdAt: 1 };
  return { deliveryId, reservationId, raw: JSON.stringify(message), message };
}

function queueActionRecorder() {
  const acknowledged: PublicationReservation[] = [];
  const retried: Array<{ reservation: PublicationReservation; options: { now?: number; delayMs: number } }> = [];
  const deadLettered: PublicationReservation[] = [];
  return {
    acknowledged,
    retried,
    deadLettered,
    queue: {
      async acknowledge(value: PublicationReservation) { acknowledged.push(value); return true; },
      async retry(value: PublicationReservation, options: { now?: number; delayMs: number }) { retried.push({ reservation: value, options }); return true; },
      async deadLetter(value: PublicationReservation) { deadLettered.push(value); return true; },
    },
  };
}

function hasErrorCode(code: string) {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}
