import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { enqueuePublication } from "./publication-queue.ts";
import {
  canonicalJson,
  publicationOutboxEventPath,
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
  kind: "publicationOutboxEvent";
  idempotencyKey: string;
  status: "pending" | "queued" | "completed" | "failed";
  generation: number;
  eventId: string;
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
const OUTBOX_TEMPORARY_RETENTION_MS = 24 * 60 * 60 * 1_000;

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
  await mkdir(publicationOutboxStatePath(spoolRoot, input.idempotencyKey), { recursive: true, mode: 0o750 });

  const now = options.now ?? Date.now();
  const existing = await installImmutableCommand(commandPath, encoded, now);
  await ensurePendingState(spoolRoot, input.idempotencyKey, now);
  const currentState = await readOutboxState(spoolRoot, input.idempotencyKey);
  if (currentState?.status === "completed") return { commandPath, existing };
  if (currentState?.status === "failed") {
    throw new Error(`Publication ${input.idempotencyKey} is quarantined: ${currentState.lastError ?? "unknown failure"}`);
  }
  await (options.enqueue ?? enqueuePublication)(input.idempotencyKey);
  await options.afterEnqueue?.();
  await writeOutboxEvent(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    generation: now,
    eventId: randomUUID(),
    updatedAt: now,
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
  const now = options.now ?? Date.now();
  await removeCommandTemporaries(commandDirectory, now - OUTBOX_TEMPORARY_RETENTION_MS);
  await removeStateTemporaries(stateDirectory, now - OUTBOX_TEMPORARY_RETENTION_MS);
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
      await writeOutboxEvent(spoolRoot, {
        schemaVersion: 1,
        kind: "publicationOutboxEvent",
        idempotencyKey,
        status: "queued",
        generation: now,
        eventId: randomUUID(),
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
  const directory = publicationOutboxStatePath(resolve(spoolRoot), idempotencyKey);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }

  const events: PublicationOutboxState[] = [];
  for (const name of names) {
    if (!/^[0-9]+-(?:pending|queued|completed|failed)-[a-z0-9-]+\.json$/.test(name)) continue;
    const value: unknown = JSON.parse(await readFile(resolve(directory, name), "utf8"));
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      value.kind !== "publicationOutboxEvent" ||
      value.idempotencyKey !== idempotencyKey ||
      !["pending", "queued", "completed", "failed"].includes(String(value.status)) ||
      !Number.isSafeInteger(value.generation) ||
      typeof value.eventId !== "string" ||
      !Number.isSafeInteger(value.updatedAt)
    ) {
      throw new Error(`Publication outbox state ${idempotencyKey} is invalid.`);
    }
    if (`${value.generation}-${value.status}-${value.eventId}.json` !== name) {
      throw new Error(`Publication outbox event filename does not match its contents: ${name}`);
    }
    events.push(value as PublicationOutboxState);
  }
  return events.sort(compareOutboxEvents).at(-1) ?? null;
}

export async function markPublicationCompleted(
  idempotencyKey: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
  generation = now,
): Promise<void> {
  await writeOutboxEvent(resolve(spoolRoot), {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey,
    status: "completed",
    generation,
    eventId: randomUUID(),
    updatedAt: now,
  });
}

export async function markPublicationFailed(
  idempotencyKey: string,
  reason: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
  generation = now,
): Promise<void> {
  await writeOutboxEvent(resolve(spoolRoot), {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey,
    status: "failed",
    generation,
    eventId: randomUUID(),
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

async function installImmutableCommand(path: string, contents: string, createdAt: number): Promise<boolean> {
  const temporaryPath = `${path}.${createdAt}.${randomUUID()}.tmp`;
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
  await writeOutboxEvent(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey,
    status: "pending",
    generation: now,
    eventId: randomUUID(),
    updatedAt: now,
  });
}

async function writeOutboxEvent(spoolRoot: string, state: PublicationOutboxState): Promise<void> {
  const path = publicationOutboxEventPath(
    resolve(spoolRoot),
    state.idempotencyKey,
    state.generation,
    state.status,
    state.eventId,
  );
  await mkdir(dirname(path), { recursive: true, mode: 0o750 });
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
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

async function removeStateTemporaries(directory: string, olderThan: number): Promise<void> {
  for (const name of await readdir(directory)) {
    const path = resolve(directory, name);
    const metadata = await lstat(path);
    if (!metadata.isDirectory()) continue;
    for (const eventName of await readdir(path)) {
      const match = /^([0-9]+)-.*\.json\.tmp$/.exec(eventName);
      if (match && Number(match[1]) < olderThan) await rm(resolve(path, eventName), { force: true });
    }
    await syncDirectory(path);
  }
  await syncDirectory(directory);
}

async function removeCommandTemporaries(directory: string, olderThan: number): Promise<void> {
  for (const name of await readdir(directory)) {
    const match = /^[a-z0-9-]+\.json\.([0-9]+)\.[a-z0-9-]+\.tmp$/.exec(name);
    if (match && Number(match[1]) < olderThan) {
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

function compareOutboxEvents(left: PublicationOutboxState, right: PublicationOutboxState): number {
  const precedence = { pending: 0, queued: 1, failed: 2, completed: 3 } as const;
  return precedence[left.status] - precedence[right.status]
    || left.generation - right.generation
    || left.eventId.localeCompare(right.eventId);
}
