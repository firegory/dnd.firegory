import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { enqueuePublication } from "./publication-queue.ts";
import {
  canonicalJson,
  publicationOutboxStatePath,
  publicationQuarantinePath,
  publicationSpoolPath,
  type CanonicalRevision,
  type JsonValue,
} from "./repository.ts";
import { assertCanonicalRevision } from "./validation.ts";

export type PublicationCommand = Readonly<{
  schemaVersion: 1;
  kind: "publishCanonicalRevision";
  idempotencyKey: string;
  revision: CanonicalRevision;
}>;

export type PublicationOutboxState = Readonly<{
  schemaVersion: 1;
  kind: "publicationOutboxState";
  idempotencyKey: string;
  status: "pending" | "queued" | "completed" | "failed";
  updatedAt: number;
  lastError?: string;
}>;

export class PublicationCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicationCommandError";
  }
}

type Enqueue = (idempotencyKey: string) => Promise<unknown>;

export function getPublicationSpoolRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PUBLICATION_SPOOL_ROOT?.trim();
  const storageRoot = environment.STORAGE_ROOT?.trim() || "./storage";
  return resolve(configured || resolve(storageRoot, "publication-spool"));
}

export async function submitPublicationCommand(
  input: Readonly<{ idempotencyKey: string; revision: CanonicalRevision }>,
  options: Readonly<{
    spoolRoot?: string;
    enqueue?: Enqueue;
    now?: number;
    afterEnqueue?: () => void | Promise<void>;
  }> = {},
): Promise<Readonly<{ commandPath: string; existing: boolean }>> {
  assertCanonicalRevision(input.revision);
  const spoolRoot = resolve(options.spoolRoot ?? getPublicationSpoolRoot());
  const commandPath = publicationSpoolPath(spoolRoot, input.idempotencyKey);
  const command: PublicationCommand = {
    schemaVersion: 1,
    kind: "publishCanonicalRevision",
    idempotencyKey: input.idempotencyKey,
    revision: input.revision,
  };
  const encoded = `${canonicalJson(command as unknown as JsonValue)}\n`;
  await mkdir(dirname(commandPath), { recursive: true, mode: 0o750 });
  await mkdir(dirname(publicationOutboxStatePath(spoolRoot, input.idempotencyKey)), { recursive: true, mode: 0o750 });

  const existing = await installImmutableCommand(commandPath, encoded);
  await ensurePendingState(spoolRoot, input.idempotencyKey, options.now ?? Date.now());
  const currentState = await readOutboxState(spoolRoot, input.idempotencyKey);
  if (currentState?.status === "completed") return { commandPath, existing };
  if (currentState?.status === "failed") {
    throw new Error(`Publication ${input.idempotencyKey} is quarantined: ${currentState.lastError ?? "unknown failure"}`);
  }
  await (options.enqueue ?? enqueuePublication)(input.idempotencyKey);
  await options.afterEnqueue?.();
  await writeOutboxState(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxState",
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    updatedAt: options.now ?? Date.now(),
  });
  return { commandPath, existing };
}

export async function reconcilePublicationOutbox(options: Readonly<{
  spoolRoot?: string;
  enqueue?: Enqueue;
  now?: number;
  redeliveryAfterMs?: number;
}> = {}): Promise<Readonly<{ enqueued: number; failed: number }>> {
  const spoolRoot = resolve(options.spoolRoot ?? getPublicationSpoolRoot());
  const commandDirectory = dirname(publicationSpoolPath(spoolRoot, "placeholder"));
  const stateDirectory = dirname(publicationOutboxStatePath(spoolRoot, "placeholder"));
  await mkdir(commandDirectory, { recursive: true, mode: 0o750 });
  await mkdir(stateDirectory, { recursive: true, mode: 0o750 });
  await removeCommandTemporaries(commandDirectory);
  await removeStateTemporaries(stateDirectory);
  const now = options.now ?? Date.now();
  const redeliveryAfterMs = options.redeliveryAfterMs ?? 5 * 60_000;
  let enqueued = 0;
  let failed = 0;

  for (const name of await readdir(commandDirectory)) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?)\.json$/.exec(name);
    if (!match) continue;
    const idempotencyKey = match[1];
    let state: PublicationOutboxState | null;
    try {
      state = await readOutboxState(spoolRoot, idempotencyKey);
    } catch (error) {
      const reason = errorMessage(error);
      await markPublicationFailed(idempotencyKey, reason, spoolRoot, now);
      await quarantineOutboxFailure(spoolRoot, idempotencyKey, reason, now);
      failed++;
      continue;
    }
    if (state?.status === "completed" || state?.status === "failed") continue;
    if (state?.status === "queued" && now - state.updatedAt < redeliveryAfterMs) continue;
    try {
      await loadPublicationCommand(idempotencyKey, spoolRoot);
    } catch (error) {
      const reason = errorMessage(error);
      await markPublicationFailed(idempotencyKey, reason, spoolRoot, now);
      await quarantineOutboxFailure(spoolRoot, idempotencyKey, reason, now);
      failed++;
      continue;
    }

    try {
      await (options.enqueue ?? enqueuePublication)(idempotencyKey);
      await writeOutboxState(spoolRoot, {
        schemaVersion: 1,
        kind: "publicationOutboxState",
        idempotencyKey,
        status: "queued",
        updatedAt: now,
      });
      enqueued++;
    } catch {
      // The durable state remains pending/stale so the next reconciliation retries.
    }
  }
  return { enqueued, failed };
}

export async function loadPublicationCommand(
  idempotencyKey: string,
  spoolRoot = getPublicationSpoolRoot(),
): Promise<PublicationCommand> {
  const commandPath = publicationSpoolPath(resolve(spoolRoot), idempotencyKey);
  const value: unknown = JSON.parse(await readFile(commandPath, "utf8"));
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    value.kind !== "publishCanonicalRevision" ||
    value.idempotencyKey !== idempotencyKey
  ) {
    throw new PublicationCommandError(`Publication command ${idempotencyKey} is invalid.`);
  }
  assertCanonicalRevision(value.revision);
  return value as PublicationCommand;
}

export async function readOutboxState(
  spoolRoot: string,
  idempotencyKey: string,
): Promise<PublicationOutboxState | null> {
  try {
    const value: unknown = JSON.parse(await readFile(publicationOutboxStatePath(resolve(spoolRoot), idempotencyKey), "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== "publicationOutboxState" ||
      value.idempotencyKey !== idempotencyKey ||
      !["pending", "queued", "completed", "failed"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      throw new Error(`Publication outbox state ${idempotencyKey} is invalid.`);
    }
    return value as PublicationOutboxState;
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

export async function markPublicationCompleted(
  idempotencyKey: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
): Promise<void> {
  await writeOutboxState(resolve(spoolRoot), {
    schemaVersion: 1,
    kind: "publicationOutboxState",
    idempotencyKey,
    status: "completed",
    updatedAt: now,
  });
}

export async function markPublicationFailed(
  idempotencyKey: string,
  reason: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
): Promise<void> {
  await writeOutboxState(resolve(spoolRoot), {
    schemaVersion: 1,
    kind: "publicationOutboxState",
    idempotencyKey,
    status: "failed",
    updatedAt: now,
    lastError: reason,
  });
}

export async function quarantinePublication(
  deliveryId: string,
  raw: string,
  reason: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
): Promise<void> {
  const path = publicationQuarantinePath(resolve(spoolRoot), deliveryId);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  await atomicDurableWrite(path, `${JSON.stringify({ deliveryId, raw, reason, failedAt: now }, null, 2)}\n`);
}

async function installImmutableCommand(path: string, contents: string): Promise<boolean> {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporaryPath, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  let existing = false;
  try {
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      existing = true;
      if (await readFile(path, "utf8") !== contents) {
        throw new Error(`Idempotency key ${path} is already bound to another publication.`);
      }
    }
    await syncDirectory(dirname(path));
    return existing;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensurePendingState(spoolRoot: string, idempotencyKey: string, now: number): Promise<void> {
  const state = await readOutboxState(spoolRoot, idempotencyKey);
  if (state) return;
  await writeOutboxState(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxState",
    idempotencyKey,
    status: "pending",
    updatedAt: now,
  });
}

async function writeOutboxState(spoolRoot: string, state: PublicationOutboxState): Promise<void> {
  const path = publicationOutboxStatePath(resolve(spoolRoot), state.idempotencyKey);
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  await atomicDurableWrite(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function atomicDurableWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(contents, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function removeStateTemporaries(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (/^[a-z0-9-]+\.json\.[a-z0-9-]+\.tmp$/.test(name)) {
      await rm(resolve(directory, name), { force: true });
    }
  }
  await syncDirectory(directory);
}

async function removeCommandTemporaries(directory: string): Promise<void> {
  for (const name of await readdir(directory)) {
    if (/^[a-z0-9-]+\.json\.[a-z0-9-]+\.tmp$/.test(name)) {
      await rm(resolve(directory, name), { force: true });
    }
  }
  await syncDirectory(directory);
}

async function quarantineOutboxFailure(
  spoolRoot: string,
  idempotencyKey: string,
  reason: string,
  now: number,
): Promise<void> {
  let raw = "";
  try {
    raw = await readFile(publicationSpoolPath(spoolRoot, idempotencyKey), "utf8");
  } catch {
    // The failure record remains useful even when the command cannot be read.
  }
  await quarantinePublication(idempotencyKey, raw, reason, spoolRoot, now);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
