import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_PDF_INPUT_BYTES } from "../../server/ingestion/limits.ts";

const PDF_MAGIC = Buffer.from("%PDF-");

export type ImmutablePdfSnapshot = Readonly<{
  path: string;
  size: number;
  checksumSha256: string;
  cleanup(): Promise<void>;
}>;

export async function assertBoundedFile(
  path: string,
  maxBytes: number,
  label: string,
): Promise<number> {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink()) throw new Error(`${label} is a symbolic link`);
  if (!metadata.isFile()) throw new Error(`${label} is not a regular file`);
  if (metadata.size > maxBytes) throw new Error(`${label} exceeds size limit of ${maxBytes} bytes`);
  return metadata.size;
}

export async function createImmutablePdfSnapshot(
  sourcePath: string,
  options: Readonly<{ afterOpen?: () => void | Promise<void> }> = {},
): Promise<ImmutablePdfSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "dnd-pdf-snapshot-"));
  await chmod(directory, 0o700);
  const snapshotPath = join(directory, "input.pdf");
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;
  try {
    source = await open(sourcePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await source.stat();
    if (!before.isFile()) throw new Error("Original PDF is not a regular file");
    if (before.size > MAX_PDF_INPUT_BYTES) {
      throw new Error(`Original PDF exceeds size limit of ${MAX_PDF_INPUT_BYTES} bytes`);
    }
    await options.afterOpen?.();

    const magic = Buffer.alloc(PDF_MAGIC.length);
    const { bytesRead } = await source.read(magic, 0, magic.length, 0);
    if (bytesRead !== PDF_MAGIC.length || !magic.equals(PDF_MAGIC)) {
      throw new Error("File is not a valid PDF (missing %PDF- header)");
    }

    destination = await open(snapshotPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    const hash = createHash("sha256");
    let copied = 0;
    for await (const value of source.createReadStream({ autoClose: false, start: 0 })) {
      const chunk = value as Buffer;
      copied += chunk.length;
      if (copied > MAX_PDF_INPUT_BYTES) throw new Error(`Original PDF exceeds size limit of ${MAX_PDF_INPUT_BYTES} bytes`);
      hash.update(chunk);
      await destination.write(chunk);
    }
    await destination.sync();

    const after = await source.stat();
    const pathAfter = await lstat(sourcePath);
    if (copied !== before.size
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || pathAfter.isSymbolicLink() || pathAfter.dev !== before.dev || pathAfter.ino !== before.ino) {
      throw new Error("Original PDF changed while creating immutable snapshot");
    }
    await destination.close();
    destination = undefined;
    await source.close();
    source = undefined;
    await chmod(snapshotPath, 0o400);
    return {
      path: snapshotPath,
      size: copied,
      checksumSha256: hash.digest("hex"),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await Promise.allSettled([source?.close(), destination?.close()]);
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function readBoundedUtf8(path: string, maxBytes: number, label: string): Promise<string> {
  const size = await assertBoundedFile(path, maxBytes, label);
  const handle = await open(path, "r");
  try {
    const output = Buffer.alloc(size);
    const { bytesRead } = await handle.read(output, 0, size, 0);
    return output.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function writeJsonLinesBounded(
  path: string,
  values: Iterable<unknown>,
  maxBytes: number,
  label: string,
): Promise<void> {
  const handle = await open(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  let bytes = 0;
  try {
    for (const value of values) {
      const line = `${JSON.stringify(value)}\n`;
      bytes += Buffer.byteLength(line);
      if (bytes > maxBytes) throw new Error(`${label} exceeds size limit of ${maxBytes} bytes`);
      await handle.write(line);
    }
  } catch (error) {
    await handle.close();
    await rm(path, { force: true });
    throw error;
  }
  await handle.close();
}
