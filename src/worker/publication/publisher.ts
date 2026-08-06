import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import {
  loadPublicationCommand,
  type PublicationCommand,
} from "../../server/content-storage/publication-command.ts";
import {
  canonicalJson,
  canonicalRevisionPath,
  manifestPath,
  publicationManifestTemporaryPath,
  publicationStagingPath,
  publicationStagingTemporaryPath,
  type JsonValue,
  type RepositoryManifest,
} from "../../server/content-storage/repository.ts";
import {
  assertCanonicalRevision,
  assertRepositoryManifest,
  ContentIntegrityError,
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
  beforeManifestRename?: () => void | Promise<void>;
}>;

export async function publishCanonicalRevision(options: Readonly<{
  dataRoot: string;
  command: PublicationCommand;
  leaseManager?: PublicationLeaseManager;
  fenceManager?: PublicationFenceManager;
  leaseTtlMs?: number;
  hooks?: PublicationHooks;
}>): Promise<PublicationResult> {
  assertCanonicalRevision(options.command.revision);
  const root = await canonicalRoot(options.dataRoot);
  const initialManifest = await readManifest(root);
  const leaseManager = options.leaseManager ?? new RedisPublicationLeaseManager();
  const leaseTtlMs = options.leaseTtlMs ?? 30_000;
  const lease = await leaseManager.acquire(initialManifest.repositoryId, leaseTtlMs);
  if (!lease) throw new PublicationLeaseUnavailableError(initialManifest.repositoryId);

  let leaseLost = false;
  const renewal = setInterval(() => {
    void lease.renew().then((owned) => { leaseLost ||= !owned; }).catch(() => { leaseLost = true; });
  }, Math.max(1, Math.floor(leaseTtlMs / 3)));
  renewal.unref();

  try {
    const fenceManager = options.fenceManager ?? new PostgresPublicationFenceManager();
    const fence = await fenceManager.acquire(initialManifest.repositoryId);
    if (!fence) throw new PublicationFenceUnavailableError(initialManifest.repositoryId);

    try {
      options.hooks?.onCanonicalPhase?.(true);
      await assertLease(lease, leaseLost);
      await fence.verify();
      const manifest = await readManifest(root);
      if (manifest.repositoryId !== initialManifest.repositoryId) {
        throw new ContentIntegrityError("Repository identity changed while acquiring its publication fence.");
      }

      const revision = options.command.revision;
      await validateCanonicalRevisionDependencies(root, revision);
      const active = manifest.entries.find((entry) => entry.entryId === revision.entryId);
      if (active?.revisionId === revision.revisionId) {
        return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: true };
      }

      const stagingFile = publicationStagingPath(root, revision.entryId, revision.revisionId);
      const revisionFile = canonicalRevisionPath(root, revision.entryId, revision.revisionId);
      const stagingDirectory = dirname(stagingFile);
      const revisionDirectory = dirname(revisionFile);
      await ensureCanonicalDirectory(root, stagingDirectory);
      await ensureCanonicalDirectory(root, revisionDirectory);
      await removeAbandonedTemporaryFiles(root, stagingDirectory, /^\.rev-[0-9a-f]{64}\.[a-z0-9-]+\.tmp$/);
      await removeAbandonedTemporaryFiles(root, dirname(manifestPath(root)), /^\.repository-[a-z0-9-]+\.tmp$/);

      await fence.verify();
      const encodedRevision = `${canonicalJson(revision as unknown as JsonValue)}\n`;
      await stageRevision({
        root,
        stagingFile,
        contents: encodedRevision,
        afterTemporarySynced: options.hooks?.afterStagingTemporarySynced,
      });
      await options.hooks?.afterStagingInstalled?.();

      await assertLease(lease, leaseLost);
      await fence.verify();
      await promoteRevision(root, stagingFile, revisionFile, encodedRevision);

      await options.hooks?.beforeActivation?.();
      await assertLease(lease, leaseLost);
      await fence.verify();
      const nextManifest: RepositoryManifest = {
        ...manifest,
        entries: [
          ...manifest.entries.filter((entry) => entry.entryId !== revision.entryId),
          {
            entryId: revision.entryId,
            revisionId: revision.revisionId,
            path: relative(root, revisionFile).replaceAll("\\", "/"),
            contentHash: revision.contentHash,
          },
        ].sort((left, right) => left.entryId.localeCompare(right.entryId)),
      };
      assertRepositoryManifest(nextManifest);
      await activateManifest(root, nextManifest, lease.ownerId.toLowerCase(), options.hooks?.beforeManifestRename, fence.verify);

      return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: false };
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
  leaseManager?: PublicationLeaseManager;
  fenceManager?: PublicationFenceManager;
  leaseTtlMs?: number;
}>): Promise<PublicationResult> {
  const command = await loadPublicationCommand(options.idempotencyKey, options.spoolRoot);
  return publishCanonicalRevision({
    dataRoot: options.dataRoot,
    command,
    leaseManager: options.leaseManager,
    fenceManager: options.fenceManager,
    leaseTtlMs: options.leaseTtlMs,
  });
}

async function readManifest(root: string): Promise<RepositoryManifest> {
  const path = manifestPath(root);
  await assertCanonicalRegularFile(root, path);
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertRepositoryManifest(value);
  return value;
}

async function stageRevision(options: Readonly<{
  root: string;
  stagingFile: string;
  contents: string;
  afterTemporarySynced?: () => void | Promise<void>;
}>): Promise<void> {
  const temporaryId = randomUUID();
  const revisionId = basename(options.stagingFile, ".json");
  const entryId = basename(dirname(options.stagingFile));
  const temporary = publicationStagingTemporaryPath(options.root, entryId, revisionId, temporaryId);
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
    if (await readFile(revisionFile, "utf8") !== contents) {
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

async function activateManifest(
  root: string,
  manifest: RepositoryManifest,
  ownerId: string,
  beforeRename?: () => void | Promise<void>,
  verifyFence?: () => Promise<void>,
): Promise<void> {
  const activeManifest = manifestPath(root);
  await assertCanonicalRegularFile(root, activeManifest);
  const temporary = publicationManifestTemporaryPath(root, ownerId);
  const file = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await file.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await beforeRename?.();
    await verifyFence?.();
    await assertCanonicalAncestors(root, activeManifest);
    await assertCanonicalRegularFile(root, activeManifest);
    await rename(temporary, activeManifest);
    await syncDirectory(dirname(activeManifest));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeAbandonedTemporaryFiles(root: string, directory: string, pattern: RegExp): Promise<void> {
  await assertCanonicalAncestors(root, resolve(directory, "placeholder"));
  for (const name of await readdir(directory)) {
    if (!pattern.test(name)) continue;
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      throw new ContentIntegrityError(`Abandoned publication temporary path is a directory: ${path}`);
    }
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
