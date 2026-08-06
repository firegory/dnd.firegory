import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { enqueuePublication } from "./publication-queue.ts";
import {
  ownsPublicationGenerationReservation,
  reservePublicationGeneration,
} from "./publication-generation.ts";
import {
  canonicalJson,
  getDataRoot,
  publicationOutboxEventPath,
  publicationOutboxStatePath,
  publicationQuarantinePath,
  publicationSpoolPath,
  assertStableId,
  type CanonicalRevision,
  type JsonValue,
} from "./repository.ts";
import { assertCanonicalRevision } from "./validation.ts";

export type PublicationCommand = Readonly<{
  schemaVersion: 1;
  kind: "publishCanonicalRevision";
  idempotencyKey: string;
  generation: string;
  revision: CanonicalRevision;
}> | Readonly<{
  schemaVersion: 1;
  kind: "unpublishCanonicalEntry";
  idempotencyKey: string;
  generation: string;
  entryId: string;
}>;

export type PublicationOutboxState = Readonly<{
  schemaVersion: 1;
  kind: "publicationOutboxEvent";
  idempotencyKey: string;
  status: "pending" | "queued" | "completed" | "failed";
  generation: string;
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

type Enqueue = (idempotencyKey: string, generation: string) => Promise<unknown>;
type SubmitOptions = Readonly<{
  spoolRoot?: string;
  dataRoot?: string;
  enqueue?: Enqueue;
  now?: number;
  afterEnqueue?: () => void | Promise<void>;
  beforeGenerationCreate?: (generation: string) => void | Promise<void>;
  beforeGenerationLink?: (generation: string) => void | Promise<void>;
  afterGenerationReserved?: (generation: string) => void | Promise<void>;
}>;
const OUTBOX_TEMPORARY_RETENTION_MS = 24 * 60 * 60 * 1_000;

export function getPublicationSpoolRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PUBLICATION_SPOOL_ROOT?.trim();
  const storageRoot = environment.STORAGE_ROOT?.trim() || "./storage";
  return resolve(configured || resolve(storageRoot, "publication-spool"));
}

export async function submitPublicationCommand(
  input: Readonly<{ idempotencyKey: string; revision: CanonicalRevision }>,
  options: SubmitOptions = {},
): Promise<Readonly<{ commandPath: string; existing: boolean }>> {
  assertCanonicalRevision(input.revision);
  return submitCanonicalCommand({
    schemaVersion: 1,
    kind: "publishCanonicalRevision",
    idempotencyKey: input.idempotencyKey,
    revision: input.revision,
  }, options);
}

export async function submitUnpublicationCommand(
  input: Readonly<{ idempotencyKey: string; entryId: string }>,
  options: SubmitOptions = {},
): Promise<Readonly<{ commandPath: string; existing: boolean }>> {
  assertStableId(input.idempotencyKey, "idempotencyKey");
  assertStableId(input.entryId, "entryId");
  return submitCanonicalCommand({
    schemaVersion: 1,
    kind: "unpublishCanonicalEntry",
    idempotencyKey: input.idempotencyKey,
    entryId: input.entryId,
  }, options);
}

type UnreservedPublicationCommand =
  | Omit<Extract<PublicationCommand, { kind: "publishCanonicalRevision" }>, "generation">
  | Omit<Extract<PublicationCommand, { kind: "unpublishCanonicalEntry" }>, "generation">;

async function submitCanonicalCommand(
  input: UnreservedPublicationCommand,
  options: SubmitOptions,
): Promise<Readonly<{ commandPath: string; existing: boolean }>> {
  const spoolRoot = resolve(options.spoolRoot ?? getPublicationSpoolRoot());
  const commandPath = publicationSpoolPath(spoolRoot, input.idempotencyKey);
  const existingCommand = await loadPublicationCommandIfPresent(input.idempotencyKey, spoolRoot);
  if (existingCommand) {
    assertSameCommand(existingCommand, input, input.idempotencyKey);
    return enqueueExistingCommand(existingCommand, commandPath, options, spoolRoot);
  }
  const dataRoot = resolve(options.dataRoot ?? getDataRoot());
  let generation: string;
  for (;;) {
    const reservation = await reservePublicationGeneration({
      spoolRoot,
      dataRoot,
      idempotencyKey: input.idempotencyKey,
      now: options.now,
      beforeCreate: options.beforeGenerationCreate,
      beforeLink: options.beforeGenerationLink,
    });
    generation = reservation.generation;
    await options.afterGenerationReserved?.(generation);
    if (await ownsPublicationGenerationReservation(spoolRoot, reservation)) break;
  }
  const command = { ...input, generation } as PublicationCommand;
  const encoded = `${canonicalJson(command as unknown as JsonValue)}\n`;
  await mkdir(dirname(commandPath), { recursive: true, mode: 0o750 });
  await mkdir(publicationOutboxStatePath(spoolRoot, input.idempotencyKey), { recursive: true, mode: 0o750 });

  const now = options.now ?? Date.now();
  const existing = await installImmutableCommand(commandPath, encoded, now);
  const installedCommand = existing
    ? await loadPublicationCommand(input.idempotencyKey, spoolRoot)
    : command;
  assertSameCommand(installedCommand, input, input.idempotencyKey);
  await ensurePendingState(spoolRoot, input.idempotencyKey, installedCommand.generation, now);
  const currentState = await readOutboxState(spoolRoot, input.idempotencyKey);
  if (currentState?.status === "completed") return { commandPath, existing };
  if (currentState?.status === "failed") {
    throw new Error(`Publication ${input.idempotencyKey} is quarantined: ${currentState.lastError ?? "unknown failure"}`);
  }
  await (options.enqueue ?? enqueuePublication)(input.idempotencyKey, installedCommand.generation);
  await options.afterEnqueue?.();
  await writeOutboxEvent(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    generation: installedCommand.generation,
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
      await markPublicationFailed(idempotencyKey, "0".repeat(32), reason, spoolRoot, now);
      await quarantineOutboxFailure(spoolRoot, idempotencyKey, reason, now);
      failed++;
      continue;
    }
    if (state?.status === "completed" || state?.status === "failed") continue;
    if (state?.status === "queued" && now - state.updatedAt < redeliveryAfterMs) continue;
    let command: PublicationCommand;
    try {
      command = await loadPublicationCommand(idempotencyKey, spoolRoot);
      state ??= null;
      if (state && state.generation !== command.generation) {
        throw new PublicationCommandError(`Outbox generation does not match command ${idempotencyKey}.`);
      }
    } catch (error) {
      const reason = errorMessage(error);
      await markPublicationFailed(idempotencyKey, state?.generation ?? "0".repeat(32), reason, spoolRoot, now);
      await quarantineOutboxFailure(spoolRoot, idempotencyKey, reason, now);
      failed++;
      continue;
    }

    try {
      await (options.enqueue ?? enqueuePublication)(idempotencyKey, command.generation);
      await writeOutboxEvent(spoolRoot, {
        schemaVersion: 1,
        kind: "publicationOutboxEvent",
        idempotencyKey,
        status: "queued",
        generation: command.generation,
        eventId: randomUUID(),
        updatedAt: now,
      });
      enqueued++;
    } catch {
      // Pending/stale state remains eligible for the next reconciliation pass.
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
    !["publishCanonicalRevision", "unpublishCanonicalEntry"].includes(String(value.kind)) ||
    value.idempotencyKey !== idempotencyKey ||
    typeof value.generation !== "string" ||
    !/^[0-9]{32}$/.test(value.generation)
  ) {
    throw new PublicationCommandError(`Publication command ${idempotencyKey} is invalid.`);
  }
  const keys = Object.keys(value).sort().join(",");
  if (value.kind === "publishCanonicalRevision") {
    if (keys !== "generation,idempotencyKey,kind,revision,schemaVersion") throw new PublicationCommandError(`Publication command ${idempotencyKey} is invalid.`);
    assertCanonicalRevision(value.revision);
  } else {
    if (keys !== "entryId,generation,idempotencyKey,kind,schemaVersion") throw new PublicationCommandError(`Publication command ${idempotencyKey} is invalid.`);
    assertStableId(String(value.entryId), "entryId");
  }
  return value as PublicationCommand;
}

export async function readOutboxState(
  spoolRoot: string,
  idempotencyKey: string,
): Promise<PublicationOutboxState | null> {
  const root = resolve(spoolRoot);
  let command: PublicationCommand | null = null;
  try {
    command = await loadPublicationCommandIfPresent(idempotencyKey, root);
  } catch {
    // Command validation is authoritative in the processor; valid events remain inspectable here.
  }
  const directory = publicationOutboxStatePath(root, idempotencyKey);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return recoveredPendingState(command);
    throw error;
  }

  const events: PublicationOutboxState[] = [];
  for (const name of names) {
    if (!/^[0-9]{32}-(?:pending|queued|completed|failed)-[a-z0-9-]+\.json$/.test(name)) continue;
    const path = resolve(directory, name);
    try {
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        value.kind !== "publicationOutboxEvent" ||
        value.idempotencyKey !== idempotencyKey ||
        !["pending", "queued", "completed", "failed"].includes(String(value.status)) ||
        typeof value.generation !== "string" ||
        !/^[0-9]{32}$/.test(value.generation) ||
        typeof value.eventId !== "string" ||
        !Number.isSafeInteger(value.updatedAt) ||
        (value.updatedAt as number) < 0 ||
        (value.lastError !== undefined && typeof value.lastError !== "string") ||
        `${value.generation}-${value.status}-${value.eventId}.json` !== name ||
        (command !== null && value.generation !== command.generation)
      ) {
        throw new Error(`Publication outbox event is invalid: ${name}`);
      }
      events.push(value as PublicationOutboxState);
    } catch {
      await quarantineOutboxEvent(root, idempotencyKey, path, name);
    }
  }
  return events.sort(compareOutboxEvents).at(-1) ?? recoveredPendingState(command);
}

export async function markPublicationCompleted(
  idempotencyKey: string,
  generation: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
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
  generation: string,
  reason: string,
  spoolRoot = getPublicationSpoolRoot(),
  now = Date.now(),
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
    }
    await syncDirectory(dirname(path));
    return existing;
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function ensurePendingState(spoolRoot: string, idempotencyKey: string, generation: string, now: number): Promise<void> {
  const state = await readOutboxState(spoolRoot, idempotencyKey);
  if (state) return;
  await writeOutboxEvent(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey,
    status: "pending",
    generation,
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
      if (!/^[0-9]{32}-(?:pending|queued|completed|failed)-[a-z0-9-]+\.json\.tmp$/.test(eventName)) continue;
      const temporary = resolve(path, eventName);
      const temporaryMetadata = await lstat(temporary);
      if (temporaryMetadata.isFile() && temporaryMetadata.mtimeMs < olderThan) {
        await rm(temporary, { force: true });
      }
    }
    await syncDirectory(path);
  }
  await syncDirectory(directory);
}

async function removeCommandTemporaries(directory: string, olderThan: number): Promise<void> {
  for (const name of await readdir(directory)) {
    if (!/^[a-z0-9-]+\.json\.[0-9]+\.[a-z0-9-]+\.tmp$/.test(name)) continue;
    const temporary = resolve(directory, name);
    const metadata = await lstat(temporary);
    if (metadata.isFile() && metadata.mtimeMs < olderThan) {
      await rm(temporary, { force: true });
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
    || left.generation.localeCompare(right.generation)
    || left.eventId.localeCompare(right.eventId);
}

function recoveredPendingState(command: PublicationCommand | null): PublicationOutboxState | null {
  if (!command) return null;
  return {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey: command.idempotencyKey,
    status: "pending",
    generation: command.generation,
    eventId: "recovered-pending",
    updatedAt: 0,
  };
}

async function quarantineOutboxEvent(
  spoolRoot: string,
  idempotencyKey: string,
  path: string,
  name: string,
): Promise<void> {
  const quarantineDirectory = resolve(spoolRoot, "quarantine", "outbox-events", idempotencyKey);
  await mkdir(quarantineDirectory, { recursive: true, mode: 0o750 });
  try {
    await rename(path, resolve(quarantineDirectory, `${name}.${randomUUID()}.invalid`));
    await syncDirectory(quarantineDirectory);
    await syncDirectory(dirname(path));
  } catch (error) {
    if (!hasCode(error, "ENOENT")) throw error;
  }
}

async function loadPublicationCommandIfPresent(
  idempotencyKey: string,
  spoolRoot: string,
): Promise<PublicationCommand | null> {
  try {
    return await loadPublicationCommand(idempotencyKey, spoolRoot);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw error;
  }
}

async function enqueueExistingCommand(
  command: PublicationCommand,
  commandPath: string,
  options: SubmitOptions,
  spoolRoot: string,
): Promise<Readonly<{ commandPath: string; existing: boolean }>> {
  const now = options.now ?? Date.now();
  await ensurePendingState(spoolRoot, command.idempotencyKey, command.generation, now);
  const state = await readOutboxState(spoolRoot, command.idempotencyKey);
  if (state?.status === "completed") return { commandPath, existing: true };
  if (state?.status === "failed") {
    throw new Error(`Publication ${command.idempotencyKey} is quarantined: ${state.lastError ?? "unknown failure"}`);
  }
  await (options.enqueue ?? enqueuePublication)(command.idempotencyKey, command.generation);
  await options.afterEnqueue?.();
  await writeOutboxEvent(spoolRoot, {
    schemaVersion: 1,
    kind: "publicationOutboxEvent",
    idempotencyKey: command.idempotencyKey,
    status: "queued",
    generation: command.generation,
    eventId: randomUUID(),
    updatedAt: now,
  });
  return { commandPath, existing: true };
}

function assertSameCommand(command: PublicationCommand, input: UnreservedPublicationCommand, idempotencyKey: string): void {
  const persisted: Partial<PublicationCommand> & { generation?: string } = { ...command };
  delete persisted.generation;
  if (canonicalJson(persisted as unknown as JsonValue) !== canonicalJson(input as unknown as JsonValue)) {
    throw new Error(`Idempotency key ${idempotencyKey} is already bound to another publication.`);
  }
}
