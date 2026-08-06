import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir, rename, rm } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

import {
  loadPublicationCommand,
  type PublicationCommand,
} from "../../server/content-storage/publication-command.ts";
import {
  activationDirectoryPath,
  activationManifestPath,
  activationTemporaryPath,
  canonicalJson,
  canonicalRevisionPath,
  formatActivationToken,
  parseActivationToken,
  publicationStagingPath,
  publicationStagingTemporaryPath,
  type JsonValue,
  type RepositoryActivation,
  type RepositoryManifest,
} from "../../server/content-storage/repository.ts";
import {
  assertCanonicalRevision,
  ContentIntegrityError,
  loadActiveRepositoryManifest,
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
import {
  createPostgresActivationTokenAllocator,
  type ActivationTokenAllocator,
} from "./token.ts";

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
  afterActivationTokenAllocated?: (fencingToken: string) => void | Promise<void>;
  afterActivationTemporarySynced?: () => void | Promise<void>;
}>;

export async function publishCanonicalRevision(options: Readonly<{
  dataRoot: string;
  command: PublicationCommand;
  leaseManager?: PublicationLeaseManager;
  fenceManager?: PublicationFenceManager;
  tokenAllocator?: ActivationTokenAllocator;
  leaseTtlMs?: number;
  now?: () => number;
  hooks?: PublicationHooks;
}>): Promise<PublicationResult> {
  assertCanonicalRevision(options.command.revision);
  const root = await canonicalRoot(options.dataRoot);
  const initialActive = await loadActiveRepositoryManifest(root);
  const initialManifest = initialActive.manifest;
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
      const active = await loadActiveRepositoryManifest(root);
      const manifest = active.manifest;
      if (manifest.repositoryId !== initialManifest.repositoryId) {
        throw new ContentIntegrityError("Repository identity changed while acquiring its publication fence.");
      }

      const revision = options.command.revision;
      await validateCanonicalRevisionDependencies(root, revision);
      const activeEntry = manifest.entries.find((entry) => entry.entryId === revision.entryId);
      if (activeEntry?.revisionId === revision.revisionId) {
        return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: true };
      }

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
        /^\.rev-[0-9a-f]{64}\.([0-9]+)\.[a-z0-9-]+\.tmp$/,
        now - PUBLICATION_TEMPORARY_RETENTION_MS,
      );
      await removeAbandonedTemporaryFiles(
        root,
        activationDirectory,
        /^\.[0-9]{20}\.([0-9]+)\.[a-z0-9-]+\.tmp$/,
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

      await assertLease(lease, leaseLost);
      const tokenResource = options.tokenAllocator ? null : await createPostgresActivationTokenAllocator();
      try {
        const maximumToken = await maximumActivationToken(root);
        const token = await (options.tokenAllocator ?? tokenResource!.allocator).allocate(maximumToken);
        const fencingToken = formatActivationToken(token);
        await options.hooks?.afterActivationTokenAllocated?.(fencingToken);
        await installActivation(
          root,
          nextManifest,
          fencingToken,
          lease.ownerId.toLowerCase(),
          now,
          options.hooks?.afterActivationTemporarySynced,
        );
      } finally {
        tokenResource?.release();
      }

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
  tokenAllocator?: ActivationTokenAllocator;
  leaseTtlMs?: number;
}>): Promise<PublicationResult> {
  const command = await loadPublicationCommand(options.idempotencyKey, options.spoolRoot);
  return publishCanonicalRevision({
    dataRoot: options.dataRoot,
    command,
    leaseManager: options.leaseManager,
    fenceManager: options.fenceManager,
    tokenAllocator: options.tokenAllocator,
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

async function installActivation(
  root: string,
  manifest: RepositoryManifest,
  fencingToken: string,
  ownerId: string,
  createdAt: number,
  afterTemporarySynced?: () => void | Promise<void>,
): Promise<void> {
  const activation: RepositoryActivation = {
    schemaVersion: 1,
    kind: "repositoryActivation",
    fencingToken,
    manifest,
  };
  const activationFile = activationManifestPath(root, fencingToken);
  const temporary = activationTemporaryPath(root, fencingToken, createdAt, ownerId);
  const file = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await file.writeFile(`${JSON.stringify(activation, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await afterTemporarySynced?.();
    await assertCanonicalAncestors(root, activationFile);
    if (await regularFileExists(root, activationFile)) {
      throw new ContentIntegrityError(`Activation fencing token already exists: ${fencingToken}`);
    }
    await rename(temporary, activationFile);
    await syncDirectory(dirname(activationFile));
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
    const match = pattern.exec(name);
    if (!match || Number(match[1]) >= olderThan) continue;
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      throw new ContentIntegrityError(`Abandoned publication temporary path is a directory: ${path}`);
    }
    await rm(path);
  }
  await syncDirectory(directory);
}

async function maximumActivationToken(root: string): Promise<bigint> {
  let maximum = BigInt(0);
  for (const name of await readdir(activationDirectoryPath(root))) {
    const match = /^([0-9]{20})\.json$/.exec(name);
    if (!match) continue;
    const token = parseActivationToken(match[1]);
    if (token > maximum) maximum = token;
  }
  return maximum;
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
