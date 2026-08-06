import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

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
  RedisPublicationLeaseManager,
  type PublicationLease,
  type PublicationLeaseManager,
} from "./lease.ts";

export class PublicationLeaseUnavailableError extends Error {
  constructor(targetId: string) {
    super(`Canonical publication target ${targetId} is already leased.`);
    this.name = "PublicationLeaseUnavailableError";
  }
}

export type PublicationResult = Readonly<{
  entryId: string;
  revisionId: string;
  alreadyActive: boolean;
}>;

export type PublicationHooks = Readonly<{
  onCanonicalPhase?: (active: boolean) => void;
  beforeActivation?: () => void | Promise<void>;
}>;

export async function publishCanonicalRevision(options: Readonly<{
  dataRoot: string;
  command: PublicationCommand;
  leaseManager?: PublicationLeaseManager;
  leaseTtlMs?: number;
  hooks?: PublicationHooks;
}>): Promise<PublicationResult> {
  assertCanonicalRevision(options.command.revision);
  const root = await realpath(resolve(options.dataRoot));
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
  options.hooks?.onCanonicalPhase?.(true);

  try {
    const manifest = await readManifest(root);
    if (manifest.repositoryId !== initialManifest.repositoryId) {
      throw new ContentIntegrityError("Repository identity changed while acquiring its publication lease.");
    }
    const revision = options.command.revision;
    await validateCanonicalRevisionDependencies(root, revision);
    const active = manifest.entries.find((entry) => entry.entryId === revision.entryId);
    if (active?.revisionId === revision.revisionId) {
      return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: true };
    }

    await assertLease(lease, leaseLost);
    const stagingFile = publicationStagingPath(root, revision.entryId, revision.revisionId);
    const revisionFile = canonicalRevisionPath(root, revision.entryId, revision.revisionId);
    await prepareWriteDirectory(root, dirname(stagingFile));
    await prepareWriteDirectory(root, dirname(revisionFile));
    await discardOtherStagedRevisions(dirname(stagingFile), revision.revisionId);

    const encodedRevision = `${canonicalJson(revision as unknown as JsonValue)}\n`;
    await writeImmutable(stagingFile, encodedRevision);
    await syncDirectory(dirname(stagingFile));

    await assertLease(lease, leaseLost);
    if (await exists(revisionFile)) {
      if (await readFile(revisionFile, "utf8") !== encodedRevision) {
        throw new ContentIntegrityError(`Immutable revision path ${revision.revisionId} contains different bytes.`);
      }
      await rm(stagingFile, { force: true });
    } else {
      await rename(stagingFile, revisionFile);
      await syncDirectory(dirname(revisionFile));
    }

    await options.hooks?.beforeActivation?.();
    await assertLease(lease, leaseLost);
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

    const ownerId = lease.ownerId.toLowerCase();
    const temporaryManifest = publicationManifestTemporaryPath(root, ownerId);
    const encodedManifest = `${JSON.stringify(nextManifest, null, 2)}\n`;
    await writeExclusiveSynced(temporaryManifest, encodedManifest);
    try {
      await assertLease(lease, leaseLost);
      await rename(temporaryManifest, manifestPath(root));
      await syncDirectory(dirname(manifestPath(root)));
    } finally {
      await rm(temporaryManifest, { force: true });
    }

    return { entryId: revision.entryId, revisionId: revision.revisionId, alreadyActive: false };
  } finally {
    clearInterval(renewal);
    options.hooks?.onCanonicalPhase?.(false);
    await lease.release().catch(() => false);
  }
}

export async function publishSpooledCommand(options: Readonly<{
  dataRoot: string;
  spoolRoot?: string;
  idempotencyKey: string;
  leaseManager?: PublicationLeaseManager;
  leaseTtlMs?: number;
}>): Promise<PublicationResult> {
  const command = await loadPublicationCommand(options.idempotencyKey, options.spoolRoot);
  return publishCanonicalRevision({
    dataRoot: options.dataRoot,
    command,
    leaseManager: options.leaseManager,
    leaseTtlMs: options.leaseTtlMs,
  });
}

async function readManifest(root: string): Promise<RepositoryManifest> {
  const value: unknown = JSON.parse(await readFile(manifestPath(root), "utf8"));
  assertRepositoryManifest(value);
  return value;
}

async function assertLease(lease: PublicationLease, alreadyLost: boolean): Promise<void> {
  if (alreadyLost || !await lease.renew()) throw new Error("Publication lease ownership was lost before activation.");
}

async function prepareWriteDirectory(root: string, directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const physicalDirectory = await realpath(directory);
  const fromRoot = relative(root, physicalDirectory);
  if (fromRoot === "" || fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(fromRoot)) {
    throw new ContentIntegrityError(`Canonical write directory escapes DND_DATA_ROOT: ${directory}`);
  }
}

async function writeImmutable(path: string, contents: string): Promise<void> {
  try {
    await writeExclusiveSynced(path, contents);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    if (await readFile(path, "utf8") !== contents) {
      throw new ContentIntegrityError(`Immutable staging path contains different bytes: ${path}`);
    }
  }
}

async function writeExclusiveSynced(path: string, contents: string): Promise<void> {
  const file = await open(path, "wx", 0o640);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

async function discardOtherStagedRevisions(directory: string, currentRevisionId: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (name === `${currentRevisionId}.json`) continue;
    if (/^rev-[0-9a-f]{64}\.json$/.test(name)) await rm(resolve(directory, name), { force: true });
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return false;
    throw error;
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
