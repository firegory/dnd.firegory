import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

import {
  loadPublicationCommand,
  markPublicationCompleted,
  markPublicationFailed,
  readOutboxState,
  reconcilePublicationOutbox,
  submitPublicationCommand,
  type PublicationCommand,
} from "../../src/server/content-storage/publication-command.ts";
import { createPublicationGenerationReservation } from "../../src/server/content-storage/publication-generation.ts";
import {
  activationDirectoryPath,
  activationDeltaPath,
  formatPublicationGeneration,
  publicationGenerationReservationPath,
  publicationOutboxStatePath,
  publicationQuarantinePath,
  createCanonicalRevision,
  repositoryBootstrapPath,
  publicationSpoolPath,
  publicationStagingPath,
  type CanonicalRevision,
  type CanonicalRevisionInput,
  type RepositoryManifest,
} from "../../src/server/content-storage/repository.ts";
import { type PublicationReservation } from "../../src/server/content-storage/publication-queue.ts";
import { loadResolvedRepositoryManifest, validateContentRepository } from "../../src/server/content-storage/validation.ts";
import { PostgresPublicationFenceManager, type PublicationFenceManager } from "../../src/worker/publication/fence.ts";
import { RedisPublicationLeaseManager } from "../../src/worker/publication/lease.ts";
import { processPublicationReservation } from "../../src/worker/publication/processor.ts";
import {
  PublicationFenceUnavailableError,
  publishCanonicalRevision,
} from "../../src/worker/publication/publisher.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = resolve(projectRoot, "content-repository");
const generation = (value: number) => formatPublicationGeneration(BigInt(value));

test("read-only app submission durably records intent and reconciliation closes enqueue crash windows", async (t) => {
  const root = await temporaryRepository(t);
  const spoolRoot = resolve(dirname(root), "spool");
  const revision = await nextRevision(root, "2026-08-06T01:00:00.000Z");
  const manifestBefore = await readFile(repositoryBootstrapPath(root), "utf8");
  const queued: string[] = [];
  await chmod(root, 0o555);

  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "publish-dash-v2", revision },
      {
        spoolRoot,
        dataRoot: root,
        now: 100,
        enqueue: async (key) => { queued.push(key); },
        afterEnqueue: () => { throw new Error("crash after enqueue"); },
      },
    ),
    /crash after enqueue/,
  );

  assert.equal((await readOutboxState(spoolRoot, "publish-dash-v2"))?.status, "pending");
  assert.deepEqual((await loadPublicationCommand("publish-dash-v2", spoolRoot)).revision, revision);
  assert.equal(await readFile(repositoryBootstrapPath(root), "utf8"), manifestBefore);
  assert.deepEqual(queued, ["publish-dash-v2"]);

  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 200, enqueue: async (key) => { queued.push(key); } }),
    { enqueued: 1, failed: 0 },
  );
  assert.deepEqual(queued, ["publish-dash-v2", "publish-dash-v2"]);
  assert.equal((await readOutboxState(spoolRoot, "publish-dash-v2"))?.status, "queued");

  await rm(publicationOutboxStatePath(spoolRoot, "publish-dash-v2"), { recursive: true });
  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: 300, enqueue: async (key) => { queued.push(key); } }),
    { enqueued: 1, failed: 0 },
  );
  const commandGeneration = (await loadPublicationCommand("publish-dash-v2", spoolRoot)).generation;
  await markPublicationCompleted("publish-dash-v2", commandGeneration, spoolRoot, 400);
  await submitPublicationCommand(
    { idempotencyKey: "publish-dash-v2", revision },
    { spoolRoot, dataRoot: root, enqueue: async (key) => { queued.push(key); } },
  );
  assert.equal(queued.length, 3, "completed outbox entries are not redelivered by submission");
  assert.equal(publicationSpoolPath(spoolRoot, "publish-dash-v2").includes("/commands/"), true);

  const conflicting = await revisionFromFixture("2026-08-06T01:30:00.000Z");
  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "publish-dash-v2", revision: conflicting },
      { spoolRoot, dataRoot: root, enqueue: async () => undefined },
    ),
    /already bound to another publication/,
  );

  await assert.rejects(
    submitPublicationCommand(
      { idempotencyKey: "transient-enqueue", revision: conflicting },
      { spoolRoot, dataRoot: root, enqueue: async () => { throw new Error("Redis unavailable"); } },
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
  const recentTemporary = resolve(dirname(malformedPath), "active-temp.json.1.active-worker.tmp");
  await writeFile(recentTemporary, "active");
  assert.deepEqual(
    await reconcilePublicationOutbox({ spoolRoot, now: Date.now(), enqueue: async () => undefined }),
    { enqueued: 1, failed: 1 },
  );
  assert.equal(await readFile(recentTemporary, "utf8"), "active", "cleanup uses actual mtime, not the logical filename timestamp");
  assert.equal((await readOutboxState(spoolRoot, "malformed-spool"))?.status, "failed");
  assert.equal(await readFile(publicationQuarantinePath(spoolRoot, "malformed-spool"), "utf8").then(Boolean), true);
});

test("immutable outbox events prevent completed state from regressing under races", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-outbox-race-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T01:45:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "outbox-race", revision },
    { spoolRoot, dataRoot: fixtureRoot, now: 100, enqueue: async () => undefined },
  );

  await Promise.allSettled([
    markPublicationCompleted("outbox-race", generation(1), spoolRoot, 200),
    markPublicationFailed("outbox-race", generation(1), "late duplicate failure", spoolRoot, 300),
    reconcilePublicationOutbox({ spoolRoot, now: 400, redeliveryAfterMs: 0, enqueue: async () => undefined }),
    submitPublicationCommand(
      { idempotencyKey: "outbox-race", revision },
      { spoolRoot, dataRoot: fixtureRoot, now: 500, enqueue: async () => undefined },
    ),
  ]);

  const state = await readOutboxState(spoolRoot, "outbox-race");
  assert.equal(state?.status, "completed");
  assert.equal(state?.generation, generation(1));
  assert.ok((await readdir(publicationOutboxStatePath(spoolRoot, "outbox-race"))).length >= 3);
});

test("durable generation reservations linearize submitters and survive rebuild artifacts", async (t) => {
  const root = await temporaryRepository(t);
  const spoolRoot = resolve(dirname(root), "generation-spool");
  const revision = await nextRevision(root, "2026-08-06T01:50:00.000Z");
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolveBlocked) => { releaseFirst = resolveBlocked; });
  let firstReached!: () => void;
  const reached = new Promise<void>((resolveReached) => { firstReached = resolveReached; });
  let paused = false;
  const first = submitPublicationCommand(
    { idempotencyKey: "generation-first", revision },
    {
      spoolRoot,
      dataRoot: root,
      enqueue: async () => undefined,
      beforeGenerationCreate: async () => {
        if (paused) return;
        paused = true;
        firstReached();
        await firstBlocked;
      },
    },
  );
  await reached;
  await submitPublicationCommand(
    { idempotencyKey: "generation-second", revision },
    { spoolRoot, dataRoot: root, enqueue: async () => undefined },
  );
  releaseFirst();
  await first;
  assert.equal((await loadPublicationCommand("generation-second", spoolRoot)).generation, generation(1));
  assert.equal((await loadPublicationCommand("generation-first", spoolRoot)).generation, generation(2));

  await writeFile(publicationGenerationReservationPath(spoolRoot, generation(7)), JSON.stringify({
    schemaVersion: 1,
    kind: "publicationGenerationReservation",
    generation: generation(7),
    idempotencyKey: "legacy-reservation",
    reservedAt: 1,
  }));
  await writeFile(
    publicationGenerationReservationPath(spoolRoot, generation(8)),
    JSON.stringify(createPublicationGenerationReservation(generation(8), "rebuilt-command", 1)),
  );
  await writeFile(publicationGenerationReservationPath(spoolRoot, generation(9)), "partial");
  await writeFile(publicationGenerationReservationPath(spoolRoot, "9".repeat(32)), "corrupt maximum");
  await writeFile(resolve(dirname(publicationGenerationReservationPath(spoolRoot, generation(1))), `${"9".repeat(33)}.json`), "invalid");
  await submitPublicationCommand(
    { idempotencyKey: "generation-after-rebuild", revision },
    { spoolRoot, dataRoot: root, enqueue: async () => undefined },
  );
  assert.equal((await loadPublicationCommand("generation-after-rebuild", spoolRoot)).generation, generation(9));
  assert.match(
    JSON.parse(await readFile(publicationGenerationReservationPath(spoolRoot, generation(7)), "utf8")).checksum,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.ok((await readdir(resolve(spoolRoot, "quarantine/generation-reservations"))).some((name) => name.startsWith(generation(9))));
});

test("same-target deltas order by generation while different targets compose", async (t) => {
  const root = await temporaryRepository(t);
  const dash = await nextRevision(root, "2026-08-06T01:55:00.000Z");
  const otherInput = structuredClone(dash) as Partial<CanonicalRevision>;
  delete otherInput.revisionId;
  delete otherInput.contentHash;
  otherInput.entryId = "dodge";
  const dodge = createCanonicalRevision(otherInput as CanonicalRevisionInput);

  await publish(root, publicationCommand("dash-generation-two", dash, 2));
  await publish(root, publicationCommand("dodge-generation-three", dodge, 3));
  const active = await readManifest(root);
  assert.equal(active.entries.find((entry) => entry.entryId === "dash")?.revisionId, dash.revisionId);
  assert.equal(active.entries.find((entry) => entry.entryId === "dodge")?.revisionId, dodge.revisionId);
});

test("higher per-target generation remains active when a stale writer resumes", async (t) => {
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

  const first = publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("stale-writer-first", firstRevision, 1),
    leaseManager: firstLeaseManager,
    fenceManager: firstFenceManager,
    leaseTtlMs: 100,
    hooks: {
      beforeActivationInstall: async (assignedGeneration) => {
        assert.equal(assignedGeneration, generation(1));
        fenceState.owner = null; // Simulate loss of the old PostgreSQL session lock.
        firstPaused();
        await pauseFirst;
      },
    },
  });
  await reachedPause;
  now = 101;

  const newer = await publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("stale-writer-second", secondRevision, 2),
    leaseManager: secondLeaseManager,
    fenceManager: secondFenceManager,
    leaseTtlMs: 100,
  });
  assert.equal(newer.revisionId, secondRevision.revisionId);
  assert.equal((await loadResolvedRepositoryManifest(root)).generation, generation(2));

  resumeFirst();
  await first;
  assert.deepEqual(await readdir(activationDirectoryPath(root)), [
    `${generation(1)}.json`,
    `${generation(2)}.json`,
  ]);
  assert.equal((await readManifest(root)).entries[0].revisionId, secondRevision.revisionId);
});

test("same revision at generation three fences a delayed generation-two replacement", async (t) => {
  const root = await temporaryRepository(t);
  const original = await currentRevision(root);
  const replacement = await nextRevision(root, "2026-08-06T03:05:00.000Z");
  let now = 0;
  const leases = memoryLeaseCommands(() => now);
  const fenceState = { owner: null as symbol | null };
  let resumeOlder!: () => void;
  const blocked = new Promise<void>((resolveBlocked) => { resumeOlder = resolveBlocked; });
  let olderPaused!: () => void;
  const reached = new Promise<void>((resolveReached) => { olderPaused = resolveReached; });

  const older = publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("delayed-generation-two", replacement, 2),
    leaseManager: new RedisPublicationLeaseManager(leases),
    fenceManager: memoryFenceManager(fenceState),
    leaseTtlMs: 100,
    hooks: {
      beforeActivationInstall: async () => {
        fenceState.owner = null;
        olderPaused();
        await blocked;
      },
    },
  });
  await reached;
  now = 101;
  const fencingResult = await publishCanonicalRevision({
    dataRoot: root,
    command: publicationCommand("fencing-generation-three", original, 3),
    leaseManager: new RedisPublicationLeaseManager(leases),
    fenceManager: memoryFenceManager(fenceState),
    leaseTtlMs: 100,
  });
  assert.equal(fencingResult.alreadyActive, false, "an active revision still installs its command generation delta");
  resumeOlder();
  await older;
  assert.equal((await readManifest(root)).entries[0].revisionId, original.revisionId);
  assert.deepEqual(await readdir(activationDirectoryPath(root)), [`${generation(2)}.json`, `${generation(3)}.json`]);
  assert.equal((await publish(root, publicationCommand("fencing-generation-three", original, 3))).alreadyActive, true);
});

test("a newer delta can replace a corrupt bootstrap target but unreplaced corruption still fails", async (t) => {
  const root = await temporaryRepository(t);
  const replacement = await nextRevision(root, "2026-08-06T03:10:00.000Z");
  const bootstrap = JSON.parse(await readFile(repositoryBootstrapPath(root), "utf8")) as RepositoryManifest;
  const corrupt = {
    ...bootstrap,
    entries: bootstrap.entries.map((entry) => entry.entryId === replacement.entryId
      ? { ...entry, path: `compendium/${entry.entryId}/revisions/${`rev-${"0".repeat(64)}`}.json`, revisionId: `rev-${"0".repeat(64)}`, contentHash: `sha256:${"0".repeat(64)}` }
      : entry),
  };
  await writeFile(repositoryBootstrapPath(root), `${JSON.stringify(corrupt, null, 2)}\n`);
  await assert.rejects(() => loadResolvedRepositoryManifest(root), /ENOENT|not readable/);
  await publish(root, publicationCommand("repair-bootstrap-target", replacement, 1));
  assert.equal((await readManifest(root)).entries[0].revisionId, replacement.revisionId);
  await validateContentRepository(root);
});

test("activation resolution skips corrupt higher files", async (t) => {
  const root = await temporaryRepository(t);
  const firstRevision = await nextRevision(root, "2026-08-06T03:15:00.000Z");
  await publish(root, publicationCommand("activation-one", firstRevision, 1));
  await writeFile(activationDeltaPath(root, generation(2)), "{broken");
  assert.equal((await loadResolvedRepositoryManifest(root)).generation, generation(1));

  const secondRevision = await nextRevision(root, "2026-08-06T03:30:00.000Z");
  await publish(root, publicationCommand("activation-three", secondRevision, 3));
  const active = await loadResolvedRepositoryManifest(root);
  assert.equal(active.generation, generation(3));
  assert.equal(active.manifest.entries[0].revisionId, secondRevision.revisionId);
  await writeFile(activationDeltaPath(root, generation(4)), JSON.stringify({
    schemaVersion: 1,
    kind: "repositoryActivationDelta",
    generation: generation(4),
  }));
  assert.equal((await loadResolvedRepositoryManifest(root)).generation, generation(3), "schema-invalid deltas are inert");
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
  await t.test("cleanup removes only old temporaries and preserves a concurrent recent temporary", async (st) => {
    const root = await temporaryRepository(st);
    const revision = await nextRevision(root, "2026-08-06T04:00:00.000Z");
    const staging = publicationStagingPath(root, revision.entryId, revision.revisionId);
    await mkdir(dirname(staging), { recursive: true });
    const now = Date.now();
    const abandoned = resolve(dirname(staging), `.${revision.revisionId}.1.abandoned-worker.tmp`);
    const recent = resolve(dirname(staging), `.${revision.revisionId}.${now - 1}.active-worker.tmp`);
    await writeFile(abandoned, "partial");
    await writeFile(recent, "active");
    await utimes(abandoned, new Date(0), new Date(0));
    await publish(root, publicationCommand("partial-temporary", revision), {}, now);
    await assert.rejects(readFile(abandoned), hasErrorCode("ENOENT"));
    assert.equal(await readFile(recent, "utf8"), "active");
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

  await t.test("crash after activation fsync but before installation preserves old active revision", async (st) => {
    const root = await temporaryRepository(st);
    const oldManifest = await readManifest(root);
    const revision = await nextRevision(root, "2026-08-06T07:00:00.000Z");
    const command = publicationCommand("manifest-crash", revision);
    await assert.rejects(
      publish(root, command, { afterActivationTemporarySynced: () => { throw new Error("activation crash"); } }),
      /activation crash/,
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
        /no-follow|ENOENT|escapes/,
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
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined, now: 1 },
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

test("a mismatched queue generation dead-letters only that delivery", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-generation-mismatch-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T09:30:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "generation-mismatch", revision },
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined, now: 1 },
  );
  const actions = queueActionRecorder();
  let publications = 0;
  assert.equal(await processPublicationReservation({
    reservation: reservation("wrong-generation", "wrong-reservation", "generation-mismatch", 0, 2),
    dataRoot: "/unused",
    spoolRoot,
    now: 2,
    publish: async () => { publications++; throw new Error("must not publish"); },
    queue: actions.queue,
  }), "dead-lettered");
  assert.equal((await readOutboxState(spoolRoot, "generation-mismatch"))?.status, "queued");
  assert.equal(publications, 0);

  assert.equal(await processPublicationReservation({
    reservation: reservation("correct-generation", "correct-reservation", "generation-mismatch", 0, 1),
    dataRoot: "/unused",
    spoolRoot,
    now: 3,
    publish: async () => {
      publications++;
      return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: false };
    },
    queue: actions.queue,
  }), "completed");
  assert.equal(publications, 1);
  assert.equal((await readOutboxState(spoolRoot, "generation-mismatch"))?.status, "completed");
});

test("processor applies bounded exponential retry and dead-letters the final attempt", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-retries-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T10:00:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "bounded-retry", revision },
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined },
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

test("processor renews long reservations and stops queue transitions after ownership loss", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-reservation-renewal-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T11:00:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "long-publication", revision },
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined },
  );
  const healthy = queueActionRecorder();
  assert.equal(await processPublicationReservation({
    reservation: reservation("long-delivery", "long-reservation", "long-publication", 0),
    dataRoot: "/unused",
    spoolRoot,
    visibilityTimeoutMs: 15,
    publish: async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 45));
      return { entryId: "dash", revisionId: revision.revisionId, alreadyActive: false };
    },
    queue: healthy.queue,
  }), "completed");
  assert.ok(healthy.renewals >= 3);

  await submitPublicationCommand(
    { idempotencyKey: "lost-reservation", revision },
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined },
  );
  const stolen = queueActionRecorder((renewal) => renewal === 1);
  assert.equal(await processPublicationReservation({
    reservation: reservation("lost-delivery", "lost-reservation", "lost-reservation", 0, 2),
    dataRoot: "/unused",
    spoolRoot,
    visibilityTimeoutMs: 15,
    publish: async () => {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
      return { entryId: "dash", revisionId: revision.revisionId, alreadyActive: false };
    },
    queue: stolen.queue,
  }), "reservation-lost");
  assert.equal(stolen.acknowledged.length, 0);
  assert.equal(stolen.retried.length, 0);
  assert.equal(stolen.deadLettered.length, 0);
  assert.equal((await readOutboxState(spoolRoot, "lost-reservation"))?.status, "completed");
});

test("normal publication contention requeues without consuming retry budget", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "dnd-contention-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const spoolRoot = resolve(parent, "spool");
  const revision = await revisionFromFixture("2026-08-06T12:00:00.000Z");
  await submitPublicationCommand(
    { idempotencyKey: "contention", revision },
    { spoolRoot, dataRoot: fixtureRoot, enqueue: async () => undefined },
  );
  const actions = queueActionRecorder();
  assert.equal(await processPublicationReservation({
    reservation: reservation("contention-delivery", "contention-reservation", "contention", 99),
    dataRoot: "/unused",
    spoolRoot,
    publish: async () => { throw new PublicationFenceUnavailableError("repository"); },
    queue: actions.queue,
  }), "retried");
  assert.equal(actions.retried[0]?.options.consumeAttempt, false);
  assert.notEqual((await readOutboxState(spoolRoot, "contention"))?.status, "failed");
});

async function publish(
  root: string,
  command: PublicationCommand,
  hooks: Parameters<typeof publishCanonicalRevision>[0]["hooks"] = {},
  now = Date.now(),
) {
  return publishCanonicalRevision({
    dataRoot: root,
    command,
    leaseManager: new RedisPublicationLeaseManager(memoryLeaseCommands()),
    fenceManager: memoryFenceManager({ owner: null }),
    now: () => now,
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
  return (await loadResolvedRepositoryManifest(root)).manifest;
}

async function nextRevision(root: string, createdAt: string): Promise<CanonicalRevision> {
  const current = await currentRevision(root);
  return revise(current, createdAt);
}

async function currentRevision(root: string): Promise<CanonicalRevision> {
  const manifest = await readManifest(root);
  return JSON.parse(await readFile(resolve(root, manifest.entries[0].path), "utf8")) as CanonicalRevision;
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

function publicationCommand(idempotencyKey: string, revision: CanonicalRevision, assignedGeneration = 1): PublicationCommand {
  return { schemaVersion: 1, kind: "publishCanonicalRevision", idempotencyKey, generation: generation(assignedGeneration), revision };
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

function reservation(deliveryId: string, reservationId: string, idempotencyKey: string, attempt: number, assignedGeneration = 1): PublicationReservation {
  const message = { deliveryId, idempotencyKey, generation: generation(assignedGeneration), attempt, createdAt: 1 };
  return { deliveryId, reservationId, raw: JSON.stringify(message), message };
}

function queueActionRecorder(renew: (renewal: number) => boolean = () => true) {
  const acknowledged: PublicationReservation[] = [];
  const retried: Array<{ reservation: PublicationReservation; options: { now?: number; delayMs: number; consumeAttempt?: boolean } }> = [];
  const deadLettered: PublicationReservation[] = [];
  let renewals = 0;
  return {
    acknowledged,
    retried,
    deadLettered,
    get renewals() { return renewals; },
    queue: {
      async acknowledge(value: PublicationReservation) { acknowledged.push(value); return true; },
      async renew() { renewals++; return renew(renewals); },
      async retry(value: PublicationReservation, options: { now?: number; delayMs: number; consumeAttempt?: boolean }) { retried.push({ reservation: value, options }); return true; },
      async deadLetter(value: PublicationReservation) { deadLettered.push(value); return true; },
    },
  };
}

function hasErrorCode(code: string) {
  return (error: unknown) => error instanceof Error && "code" in error && error.code === code;
}
