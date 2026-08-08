import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { sourceMetadataPath, type ContentSource, type JsonValue } from "../content-storage/repository.ts";
import { assertContentSource, loadRepositoryBootstrapDescriptor } from "../content-storage/validation.ts";
import { assertCanonicalRegularFile, canonicalRoot, ensureCanonicalDirectory, openDirectoryNoFollow, openExclusiveNoFollow } from "../../worker/publication/safe-filesystem.ts";
import { canonicalJson, sha256, type PreparedSeedSlot } from "./model.ts";

export async function installSeedSource(slot: PreparedSeedSlot, fileId: string, dataRoot: string, hooks: Readonly<{ afterTemporaryWritten?: (target: string) => void | Promise<void> }> = {}): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId)) throw new Error("Seed source fileId must be a UUID.");
  const root = await canonicalRoot(dataRoot);
  await loadRepositoryBootstrapDescriptor(root);
  await assertWritableCanonicalRoot(root);
  if (fileId !== slot.identities.fileId) throw new Error("Seed source fileId does not match its deterministic approved identity.");
  const source = slot.input.source;
  const sourceId = slot.identities.versionedSourceId;
  const relativeFilePath = `sources/${sourceId}/files/${fileId}.snapshot`;
  const contentSource: ContentSource = {
    schemaVersion: 1,
    kind: "source",
    sourceId,
    title: source.title,
    category: source.category,
    edition: "5.5e",
    language: source.language,
    accessTier: "open",
    shared: false,
    ownerUserId: null,
    publication: {
      code: source.publicationCode,
      title: source.title,
      publisher: source.publisher,
      releaseYear: 2024,
      revision: source.revision,
      origin: { url: source.originUrl, id: source.originId },
      attribution: source.attribution,
      sourcePriority: 0,
      canonicalBookId: source.canonicalBookId,
    },
    license: source.license,
    files: [{ fileId, path: relativeFilePath, mediaType: "application/vnd.dnd-firegory.snapshot+json", contentHash: `sha256:${slot.manifestDigest}` }],
  };
  assertContentSource(contentSource);
  const sourcePath = sourceMetadataPath(root, sourceId);
  const filePath = resolve(root, relativeFilePath);
  await ensureCanonicalDirectory(root, dirname(sourcePath));
  await ensureCanonicalDirectory(root, dirname(filePath));
  for (const evidence of slot.evidenceFiles) {
    const evidencePath = resolve(root, evidence.canonicalPath);
    await ensureCanonicalDirectory(root, dirname(evidencePath));
    await installImmutable(root, evidencePath, evidence.bytes, (bytes) => bytes.byteLength === evidence.byteLength && sha256(bytes) === evidence.sha256, hooks);
  }
  await installImmutable(root, filePath, slot.manifestBytes, (bytes) => bytes.byteLength === slot.manifestByteLength && sha256(bytes) === slot.manifestDigest, hooks);
  const sourceBytes = Buffer.from(`${canonicalJson(contentSource as unknown as JsonValue)}\n`);
  await installImmutable(root, sourcePath, sourceBytes, (bytes) => {
    try { return canonicalJson(JSON.parse(bytes.toString("utf8"))) === canonicalJson(contentSource); } catch { return false; }
  }, hooks);
  await verifySeedSource(slot, fileId, root);
}

export async function verifySeedSource(slot: PreparedSeedSlot, fileId: string, dataRoot: string): Promise<void> {
  const root = await canonicalRoot(dataRoot);
  if (fileId !== slot.identities.fileId) throw new Error("Seed source fileId does not match its deterministic approved identity.");
  const sourcePath = sourceMetadataPath(root, slot.identities.versionedSourceId);
  const sourceBytes = await readCanonicalRegular(root, sourcePath);
  const source = JSON.parse(sourceBytes.toString("utf8")) as ContentSource;
  assertContentSource(source);
  const declared = source.files.find((file) => file.fileId === fileId);
  if (!declared || declared.contentHash !== `sha256:${slot.manifestDigest}`) throw new Error(`Canonical seed source ${slot.planSlot.id} no longer declares its exact manifest.`);
  const manifestBytes = await readCanonicalRegular(root, resolve(root, declared.path));
  if (manifestBytes.byteLength !== slot.manifestByteLength || sha256(manifestBytes) !== slot.manifestDigest) throw new Error(`Canonical seed manifest ${slot.planSlot.id} is missing or changed.`);
  for (const evidence of slot.evidenceFiles) {
    const bytes = await readCanonicalRegular(root, resolve(root, evidence.canonicalPath));
    if (bytes.byteLength !== evidence.byteLength || sha256(bytes) !== evidence.sha256) throw new Error(`Canonical seed evidence ${evidence.sha256} is missing or changed.`);
  }
}

async function installImmutable(root: string, target: string, bytes: Buffer, matches: (existing: Buffer) => boolean,
  hooks: Readonly<{ afterTemporaryWritten?: (target: string) => void | Promise<void> }>): Promise<void> {
  try {
    const existing = await readCanonicalRegular(root, target);
    if (!matches(existing)) throw new Error(`Canonical seed dependency already exists with different immutable content: ${target}`);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    await hooks.afterTemporaryWritten?.(target);
  } catch (error) {
    await handle.close();
    await unlink(temporary).catch(() => undefined);
    throw error;
  } finally {
    if (handle.fd !== -1) await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    await assertCanonicalRegularFile(root, target);
    const existing = await readCanonicalRegular(root, target);
    if (!matches(existing)) throw new Error(`Canonical seed dependency raced with different immutable content: ${target}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await openDirectoryNoFollow(dirname(target));
  try { await directory.sync(); } finally { await directory.close(); }
}

async function readCanonicalRegular(root: string, path: string): Promise<Buffer> {
  await assertCanonicalRegularFile(root, path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await realpath(`/proc/self/fd/${handle.fd}`);
    const fromRoot = relative(root, opened);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Canonical seed file escaped its root while it was opened.");
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function assertWritableCanonicalRoot(root: string): Promise<void> {
  const probe = resolve(root, `.corpus-seed-write-probe-${process.pid}-${randomUUID()}`);
  let handle;
  try {
    handle = await openExclusiveNoFollow(probe, 0o600);
    await handle.writeFile(`${process.getuid?.() ?? "unknown"}:${process.getgid?.() ?? "unknown"}\n`);
    await handle.sync();
  } catch (error) {
    throw new Error(`Canonical root is not writable by the worker OS identity: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(probe).catch(() => undefined);
  }
  const directory = await openDirectoryNoFollow(root);
  try { await directory.sync(); } finally { await directory.close(); }
}

function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
