import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { ContentIntegrityError } from "../../server/content-storage/validation.ts";

export async function canonicalRoot(dataRoot: string): Promise<string> {
  return realpath(resolve(dataRoot));
}

export async function ensureCanonicalDirectory(root: string, directory: string): Promise<void> {
  const components = relativeComponents(root, directory);
  let current = root;
  for (const component of components) {
    current = resolve(current, component);
    try {
      const metadata = await lstat(current);
      assertDirectory(metadata.isDirectory(), metadata.isSymbolicLink(), current);
    } catch (error) {
      if (!hasCode(error, "ENOENT")) throw error;
      try {
        await mkdir(current, { mode: 0o750 });
      } catch (mkdirError) {
        if (!hasCode(mkdirError, "EEXIST")) throw mkdirError;
      }
      const metadata = await lstat(current);
      assertDirectory(metadata.isDirectory(), metadata.isSymbolicLink(), current);
    }
  }
}

export async function assertCanonicalAncestors(root: string, path: string): Promise<void> {
  const components = relativeComponents(root, path);
  let current = root;
  for (const component of components.slice(0, -1)) {
    current = resolve(current, component);
    const metadata = await lstat(current);
    assertDirectory(metadata.isDirectory(), metadata.isSymbolicLink(), current);
  }
}

export async function assertCanonicalRegularFile(root: string, path: string): Promise<void> {
  await assertCanonicalAncestors(root, path);
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ContentIntegrityError(`Canonical file is not a regular no-follow file: ${path}`);
  }
}

export async function openExclusiveNoFollow(path: string, mode: number) {
  return open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    mode,
  );
}

export async function openDirectoryNoFollow(path: string) {
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

function relativeComponents(root: string, path: string): string[] {
  const fromRoot = relative(root, resolve(path));
  if (
    fromRoot === "" ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new ContentIntegrityError(`Canonical mutation path escapes DND_DATA_ROOT: ${path}`);
  }
  return fromRoot.split(sep);
}

function assertDirectory(isDirectory: boolean, isSymbolicLink: boolean, path: string): void {
  if (isSymbolicLink || !isDirectory) {
    throw new ContentIntegrityError(`Canonical mutation ancestor is not a no-follow directory: ${path}`);
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
