/**
 * Pure utility functions for ingestion storage paths and checksums.
 * No DB dependency — safe to import in tests without DATABASE_URL.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export function getStorageRoot(): string {
  const root = process.env.STORAGE_ROOT || "./storage";
  return root;
}

/**
 * Returns the absolute path for original PDF storage:
 *   <STORAGE_ROOT>/originals/<sourceId>/<fileId>.pdf
 */
export function originalFilePath(sourceId: string, fileId: string): string {
  return join(getStorageRoot(), "originals", sourceId, `${fileId}.pdf`);
}

/**
 * Returns the absolute path for processed artifacts:
 *   <STORAGE_ROOT>/processed/<sourceId>/<fileId>/
 */
export function artifactsRootPath(sourceId: string, fileId: string): string {
  return join(getStorageRoot(), "processed", sourceId, fileId);
}

/**
 * Computes SHA-256 hex digest of a buffer.
 */
export function computeChecksum(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export async function computeFileChecksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
