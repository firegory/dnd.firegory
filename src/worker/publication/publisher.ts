import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import {
  loadPublicationCommand,
  type PublicationCommand,
} from "../../server/content-storage/publication-command.ts";
import {
  activationDirectoryPath,
  activationDeltaPath,
  activationTemporaryPath,
  canonicalJson,
  canonicalRevisionPath,
  publicationStagingPath,
  publicationStagingTemporaryPath,
  type JsonValue,
  type RepositoryActivationDelta,
} from "../../server/content-storage/repository.ts";
import {
  assertCanonicalRevision,
  ContentIntegrityError,
  loadRepositoryBootstrapDescriptor,
  validateCanonicalRevisionDependencies,
} from "../../server/content-storage/validation.ts";
import {
  PostgresPublicationFenceManager,
  type PublicationFenceManager,
} from "./fence.ts";
import {
  RedisPublicationLeaseManager,
  type PublicationLease,
  type PublicationLeaseManager,
} from "./lease.ts";
import {
  assertCanonicalAncestors,
  assertCanonicalRegularFile,
  canonicalRoot,
  ensureCanonicalDirectory,
  openDirectoryNoFollow,
  openExclusiveNoFollow,
} from "./safe-filesystem.ts";

export const PUBLICATION_TEMPORARY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export class PublicationLeaseUnavailableError extends Error {
  constructor(targetId: string) {
    super(`Canonical publication target ${targetId} is already leased.`);
    this.name = "PublicationLeaseUnavailableError";
  }
}

export class PublicationFenceUnavailableError extends Error {
  constructor(targetId: string) {
    super(`Canonical publication target ${targetId} is fenced by another database session.`);
    this.name = "PublicationFenceUnavailableError";
  }
}

export type PublicationResult = Readonly<{
  entryId: string;
  revisionId: string;
  alreadyActive: boolean;
}>;

export type PublicationHooks = Readonly<{
  onCanonicalPhase?: (active: boolean) => void;
  afterStagingTemporarySynced?: () => void | Promise<void>;
  afterStagingInstalled?: () => void | Promise<void>;
  beforeActivation?: () => void | Promise<void>;
  beforeActivationInstall?: (generation: string) => void | Promise<void>;
  afterActivationTemporarySynced?: () => void | Promise<void>;
}>;

export async function publishCanonicalRevision(options: Readonly<{
  dataRoot: string;
  command: PublicationCommand;
  leaseManager?: PublicationLeaseManager;
  fenceManager?: PublicationFenceManager;
  leaseTtlMs?: number;
  now?: () => number;
  hooks?: PublicationHooks;
}>): Promise<PublicationResult> {
  assertCanonicalRevision(options.command.revision);
  const root = await canonicalRoot(options.dataRoot);
  const initialBootstrap = await loadRepositoryBootstrapDescriptor(root);
  const leaseManager = options.leaseManager ?? new RedisPublicationLeaseManager();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const lease = await leaseManager.acquire(initialBootstrap.repositoryId, leaseTtlMs);
  if (!lease) throw new PublicationLeaseUnavailableError(initialBootstrap.repositoryId);

  let leaseLost = false;
  const renewal = setInterval(() => {
    void lease.renew().then((owned) => { leaseLost ||= !owned; }).catch(() => { leaseLost = true; });
  }, Math.max(1, Math.floor(leaseTtlMs / 3)));
  renewal.unref();

  try {
    const fenceManager = options.fenceManager ?? new PostgresPublicationFenceManager();
    const fence = await fenceManager.acquire(initialBootstrap.repositoryId);
    if (!fence) throw new PublicationFenceUnavailableError(initialBootstrap.repositoryId);

    try {
      options.hooks?.onCanonicalPhase?.(true);
      await assertLease(lease, leaseLost);
      await fence.verify();
      const bootstrap = await loadRepositoryBootstrapDescriptor(root);
      if (bootstrap.repositoryId !== initialBootstrap.repositoryId) {
        throw new ContentIntegrityError("Repository identity changed while acquiring its publication fence.");
      }

      const revision = options.command.revision;
      await validateCanonicalRevisionDependencies(root, revision);
      const stagingFile = publicationStagingPath(root, revision.entryId, revision.revisionId);
      const revisionFile = canonicalRevisionPath(root, revision.entryId, revision.revisionId);
      const stagingDirectory = dirname(stagingFile);
      const revisionDirectory = dirname(revisionFile);
      const activationDirectory = activationDirectoryPath(root);
      await ensureCanonicalDirectory(root, stagingDirectory);
      await ensureCanonicalDirectory(root, revisionDirectory);
      await ensureCanonicalDirectory(root, activationDirectory);

      const now = options.now?.() ?? Date.now();
      await removeAbandonedTemporaryFiles(
        root,
        stagingDirectory,
        /^\.rev-[0-9a-f]{64}\.[0-9]+\.[a-z0-9-]+\.tmp$/,
        now - PUBLICATION_TEMPORARY_RETENTION_MS,
      );
      await removeAbandonedTemporaryFiles(
        root,
        activationDirectory,
        /^\.[0-9]{32}\.[0-9]+\.[a-z0-9-]+\.tmp$/,
        now - PUBLICATION_TEMPORARY_RETENTION_MS,
      );

      await fence.verify();
      const encodedRevision = `${canonicalJson(revision as unknown as JsonValue)}\n`;
      await stageRevision({
        root,
        stagingFile,
        contents: encodedRevision,
        createdAt: now,
        afterTemporarySynced: options.hooks?.afterStagingTemporarySynced,
      });
      await options.hooks?.afterStagingInstalled?.();

      await assertLease(lease, leaseLost);
      await fence.verify();
      await promoteRevision(root, stagingFile, revisionFile, encodedRevision);
      await options.hooks?.beforeActivation?.();

      await assertLease(lease, leaseLost);
      await options.hooks?.beforeActivationInstall?.(options.command.generation);
      const alreadyActive = await installActivationDelta(
        root,
        {
          schemaVersion: 1,
          kind: "repositoryActivationDelta",
          readerContractVersion: 1,
          generation: options.command.generation,
          idempotencyKey: options.command.idempotencyKey,
          targetEntryId: revision.entryId,
          entry: {
            entryId: revision.entryId,
            revisionId: revision.revisionId,
            path: relative(root, revisionFile).replaceAll("\\", "/"),
            contentHash: revision.contentHash,
          },
        },
        lease.ownerId.toLowerCase(),
        now,
        options.hooks?.afterActivationTemporarySynced,
      );

      return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive };
    } finally {
      try {
        options.hooks?.onCanonicalPhase?.(false);
      } finally {
        await fence.release();
      }
    }
  } finally {
    clearInterval(renewal);
    await lease.release().catch(() => false);
  }
}

export async function publishSpooledCommand(options: Readonly<{
  dataRoot: string;
  spoolRoot?: string;
  idempotencyKey: string;
  expectedGeneration?: string;
  leaseManager?: PublicationLeaseManager;
  fenceManager?: PublicationFenceManager;
  leaseTtlMs?: number;
}>): Promise<PublicationResult> {
  const command = await loadPublicationCommand(options.idempotencyKey, options.spoolRoot);
  if (options.expectedGeneration !== undefined && command.generation !== options.expectedGeneration) {
    throw new ContentIntegrityError(`Queued generation does not match publication command ${options.idempotencyKey}.`);
  }
  return publishCanonicalRevision({
    dataRoot: options.dataRoot,
    command,
    leaseManager: options.leaseManager,
    fenceManager: options.fenceManager,
    leaseTtlMs: options.leaseTtlMs,
  });
}

async function stageRevision(options: Readonly<{
  root: string;
  stagingFile: string;
  contents: string;
  createdAt: number;
  afterTemporarySynced?: () => void | Promise<void>;
}>): Promise<void> {
  const temporaryId = randomUUID();
  const revisionId = basename(options.stagingFile, ".json");
  const entryId = basename(dirname(options.stagingFile));
  const temporary = publicationStagingTemporaryPath(
    options.root,
    entryId,
    revisionId,
    options.createdAt,
    temporaryId,
  );
  const file = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await file.writeFile(options.contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }

  try {
    await options.afterTemporarySynced?.();
    await assertCanonicalAncestors(options.root, options.stagingFile);
    if (await regularFileExists(options.root, options.stagingFile)) {
      if (await readFile(options.stagingFile, "utf8") !== options.contents) {
        throw new ContentIntegrityError(`Immutable staging path contains different bytes: ${options.stagingFile}`);
      }
    } else {
      await rename(temporary, options.stagingFile);
      await syncDirectory(dirname(options.stagingFile));
    }
  } finally {
    await rm(temporary, { force: true });
  }
}

async function promoteRevision(root: string, stagingFile: string, revisionFile: string, contents: string): Promise<void> {
  await assertCanonicalRegularFile(root, stagingFile);
  await assertCanonicalAncestors(root, revisionFile);
  if (await regularFileExists(root, revisionFile)) {
    let existing: unknown;
    try {
      existing = JSON.parse(await readFile(revisionFile, "utf8"));
      assertCanonicalRevision(existing);
    } catch {
      throw new ContentIntegrityError(`Immutable revision path does not contain a valid canonical revision: ${revisionFile}`);
    }
    if (`${canonicalJson(existing as unknown as JsonValue)}\n` !== contents) {
      throw new ContentIntegrityError(`Immutable revision path contains different bytes: ${revisionFile}`);
    }
    await rm(stagingFile);
    await syncDirectory(dirname(stagingFile));
    return;
  }
  await rename(stagingFile, revisionFile);
  await syncDirectory(dirname(revisionFile));
  await syncDirectory(dirname(stagingFile));
}

async function installActivationDelta(
  root: string,
  activation: RepositoryActivationDelta,
  ownerId: string,
  createdAt: number,
  afterTemporarySynced?: () => void | Promise<void>,
): Promise<boolean> {
  const activationFile = activationDeltaPath(root, activation.generation);
  const temporary = activationTemporaryPath(root, activation.generation, createdAt, ownerId);
  const contents = `${JSON.stringify(activation, null, 2)}\n`;
  const file = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await afterTemporarySynced?.();
    await assertCanonicalAncestors(root, activationFile);
    if (await regularFileExists(root, activationFile)) {
      if (await readFile(activationFile, "utf8") !== contents) {
        throw new ContentIntegrityError(`Publication generation is already bound to another activation: ${activation.generation}`);
      }
      return true;
    }
    await rename(temporary, activationFile);
    await syncDirectory(dirname(activationFile));
    return false;
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeAbandonedTemporaryFiles(
  root: string,
  directory: string,
  pattern: RegExp,
  olderThan: number,
): Promise<void> {
  await assertCanonicalAncestors(root, resolve(directory, "placeholder"));
  for (const name of await readdir(directory)) {
    if (!pattern.test(name)) continue;
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      throw new ContentIntegrityError(`Abandoned publication temporary path is a directory: ${path}`);
    }
    if (!metadata.isFile() || metadata.mtimeMs >= olderThan) continue;
    await rm(path);
  }
  await syncDirectory(directory);
}

async function regularFileExists(root: string, path: string): Promise<boolean> {
  try {
    await assertCanonicalRegularFile(root, path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function assertLease(lease: PublicationLease, alreadyLost: boolean): Promise<void> {
  if (alreadyLost || !await lease.renew()) throw new Error("Publication lease ownership was lost before canonical mutation.");
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await openDirectoryNoFollow(directory);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
