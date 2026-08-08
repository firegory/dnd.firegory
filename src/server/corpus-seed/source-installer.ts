import { link, readFile, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { sourceMetadataPath, type ContentSource, type JsonValue } from "../content-storage/repository.ts";
import { assertContentSource, loadRepositoryBootstrapDescriptor } from "../content-storage/validation.ts";
import { assertCanonicalRegularFile, canonicalRoot, ensureCanonicalDirectory, openDirectoryNoFollow, openExclusiveNoFollow } from "../../worker/publication/safe-filesystem.ts";
import { canonicalJson, sha256, type PreparedSeedSlot } from "./model.ts";

export async function installSeedSource(slot: PreparedSeedSlot, fileId: string, dataRoot: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(fileId)) throw new Error("Seed source fileId must be a UUID.");
  const root = await canonicalRoot(dataRoot);
  await loadRepositoryBootstrapDescriptor(root);
  const source = slot.input.source;
  const relativeFilePath = `sources/${source.canonicalSourceId}/files/${fileId}.snapshot`;
  const contentSource: ContentSource = {
    schemaVersion: 1,
    kind: "source",
    sourceId: source.canonicalSourceId,
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
  const sourcePath = sourceMetadataPath(root, source.canonicalSourceId);
  const filePath = resolve(root, relativeFilePath);
  await ensureCanonicalDirectory(root, dirname(sourcePath));
  await ensureCanonicalDirectory(root, dirname(filePath));
  const manifestBytes = await readFile(slot.manifestPath);
  if (manifestBytes.byteLength !== slot.manifestByteLength || sha256(manifestBytes) !== slot.manifestDigest) throw new Error(`Seed slot ${slot.planSlot.id} changed after preflight.`);
  await installImmutable(root, filePath, manifestBytes, (bytes) => sha256(bytes) === slot.manifestDigest);
  const sourceBytes = Buffer.from(`${canonicalJson(contentSource as unknown as JsonValue)}\n`);
  await installImmutable(root, sourcePath, sourceBytes, (bytes) => {
    try { return canonicalJson(JSON.parse(bytes.toString("utf8"))) === canonicalJson(contentSource); } catch { return false; }
  });
}

async function installImmutable(root: string, target: string, bytes: Buffer, matches: (existing: Buffer) => boolean): Promise<void> {
  try {
    await assertCanonicalRegularFile(root, target);
    const existing = await readFile(target);
    if (!matches(existing)) throw new Error(`Canonical seed dependency already exists with different immutable content: ${target}`);
    return;
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  const handle = await openExclusiveNoFollow(temporary, 0o640);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    await assertCanonicalRegularFile(root, target);
    const existing = await readFile(target);
    if (!matches(existing)) throw new Error(`Canonical seed dependency raced with different immutable content: ${target}`);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
  const directory = await openDirectoryNoFollow(dirname(target));
  try { await directory.sync(); } finally { await directory.close(); }
}

function hasCode(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
