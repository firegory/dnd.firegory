/**
 * Pure utility functions for ingestion storage paths and checksums.
 * No DB dependency — safe to import in tests without DATABASE_URL.
 */

import { join } from "node:path";
import { createHash } from "node:crypto";

export function getStorageRoot(): string {
  const root = process.env.STORAGE_ROOT;
  if (!root) {
    throw new Error("STORAGE_ROOT is required for ingestion storage operations.");
  }
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
