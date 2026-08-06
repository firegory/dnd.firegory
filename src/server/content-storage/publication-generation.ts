import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  formatPublicationGeneration,
  parsePublicationGeneration,
  publicationGenerationReservationPath,
  publicationSpoolPath,
} from "./repository.ts";
import {
  assertCanonicalRevision,
  loadValidRepositoryActivationDeltas,
  validateCanonicalRevisionDependencies,
} from "./validation.ts";

type PublicationGenerationReservationPayload = Readonly<{
  schemaVersion: 1;
  kind: "publicationGenerationReservation";
  generation: string;
  idempotencyKey: string;
  reservedAt: number;
}>;

export type PublicationGenerationReservation = PublicationGenerationReservationPayload & Readonly<{
  checksum: string;
}>;

export function createPublicationGenerationReservation(
  generation: string,
  idempotencyKey: string,
  reservedAt: number,
): PublicationGenerationReservation {
  parsePublicationGeneration(generation);
  assertStableId(idempotencyKey);
  if (!Number.isSafeInteger(reservedAt) || reservedAt < 0) throw new TypeError("reservedAt must be a nonnegative safe integer.");
  const payload: PublicationGenerationReservationPayload = {
    schemaVersion: 1,
    kind: "publicationGenerationReservation",
    generation,
    idempotencyKey,
    reservedAt,
  };
  return { ...payload, checksum: reservationChecksum(payload) };
}

export async function reservePublicationGeneration(options: Readonly<{
  spoolRoot: string;
  dataRoot: string;
  idempotencyKey: string;
  now?: number;
  beforeCreate?: (generation: string) => void | Promise<void>;
  beforeLink?: (generation: string) => void | Promise<void>;
}>): Promise<PublicationGenerationReservation> {
  const reservationDirectory = dirname(publicationGenerationReservationPath(options.spoolRoot, "0".repeat(32)));
  await mkdir(reservationDirectory, { recursive: true, mode: 0o750 });

  for (;;) {
    const floor = await maximumSemanticPublicationGeneration(options.spoolRoot, options.dataRoot);
    const consumed = await consumedReservationGenerations(reservationDirectory);
    let candidate = floor + BigInt(1);
    let generation = formatPublicationGeneration(candidate);
    while (consumed.has(generation)) {
      candidate += BigInt(1);
      generation = formatPublicationGeneration(candidate);
    }
    await options.beforeCreate?.(generation);
    const path = publicationGenerationReservationPath(options.spoolRoot, generation);
    const temporary = resolve(reservationDirectory, `.${generation}.${randomUUID()}.tmp`);
    const reservation = createPublicationGenerationReservation(
      generation,
      options.idempotencyKey,
      options.now ?? Date.now(),
    );
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    try {
      await options.beforeLink?.(generation);
      try {
        await link(temporary, path);
      } catch (error) {
        if (!hasCode(error, "EEXIST")) throw error;
        // Every recognized reservation name is a permanent consumed tombstone.
        continue;
      }
      await syncDirectory(reservationDirectory);
      return reservation;
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function maximumSemanticPublicationGeneration(spoolRoot: string, dataRoot: string): Promise<bigint> {
  let maximum = BigInt(0);
  const reservationDirectory = dirname(publicationGenerationReservationPath(spoolRoot, "0".repeat(32)));
  const reservations = await scanReservationGenerations(reservationDirectory);
  if (reservations.maximumValid > maximum) maximum = reservations.maximumValid;

  for (const delta of await loadValidRepositoryActivationDeltas(dataRoot)) {
    const generation = parsePublicationGeneration(delta.generation);
    if (generation > maximum) maximum = generation;
  }

  const commandDirectory = dirname(publicationSpoolPath(spoolRoot, "placeholder"));
  for (const name of await readDirectoryIfPresent(commandDirectory)) {
    const match = /^([a-z0-9-]+)\.json$/.exec(name);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(await readFile(resolve(commandDirectory, name), "utf8"));
      if (!isRecord(value)
        || value.schemaVersion !== 1
        || value.kind !== "publishCanonicalRevision"
        || value.idempotencyKey !== match[1]
        || typeof value.generation !== "string") continue;
      parsePublicationGeneration(value.generation);
      assertCanonicalRevision(value.revision);
      await validateCanonicalRevisionDependencies(dataRoot, value.revision);
      const generation = parsePublicationGeneration(value.generation);
      if (generation > maximum) maximum = generation;
    } catch {
      // Corrupt commands are quarantined by outbox processing and cannot block allocation.
    }
  }
  return maximum;
}

async function scanReservationGenerations(directory: string): Promise<Readonly<{
  consumed: Set<string>;
  maximumValid: bigint;
}>> {
  const consumed = new Set<string>();
  let maximumValid = BigInt(0);
  for (const name of await readDirectoryIfPresent(directory)) {
    const match = /^([0-9]{32})\.json$/.exec(name);
    if (!match) continue;
    consumed.add(match[1]);
    if (await isValidReservationFile(resolve(directory, name), match[1])) {
      const generation = parsePublicationGeneration(match[1]);
      if (generation > maximumValid) maximumValid = generation;
    }
  }
  return { consumed, maximumValid };
}

async function consumedReservationGenerations(directory: string): Promise<Set<string>> {
  return (await scanReservationGenerations(directory)).consumed;
}

export async function ownsPublicationGenerationReservation(
  spoolRoot: string,
  reservation: PublicationGenerationReservation,
): Promise<boolean> {
  const path = publicationGenerationReservationPath(spoolRoot, reservation.generation);
  if (!await isValidReservationFile(path, reservation.generation, reservation.idempotencyKey)) return false;
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value)
      && value.schemaVersion === reservation.schemaVersion
      && value.kind === reservation.kind
      && value.generation === reservation.generation
      && value.idempotencyKey === reservation.idempotencyKey
      && value.reservedAt === reservation.reservedAt
      && value.checksum === reservation.checksum;
  } catch {
    return false;
  }
}

async function isValidReservationFile(
  path: string,
  expectedGeneration: string,
  expectedIdempotencyKey?: string,
): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(value)
      || value.schemaVersion !== 1
      || value.kind !== "publicationGenerationReservation"
      || value.generation !== expectedGeneration
      || typeof value.idempotencyKey !== "string"
      || !Number.isSafeInteger(value.reservedAt)
      || (value.reservedAt as number) < 0) return false;
    assertStableId(value.idempotencyKey);
    if (expectedIdempotencyKey !== undefined && value.idempotencyKey !== expectedIdempotencyKey) return false;
    const payload: PublicationGenerationReservationPayload = {
      schemaVersion: 1,
      kind: "publicationGenerationReservation",
      generation: expectedGeneration,
      idempotencyKey: value.idempotencyKey,
      reservedAt: value.reservedAt as number,
    };
    const checksum = reservationChecksum(payload);
    if (value.checksum === checksum) return true;
    if (value.checksum !== undefined) return false;
    await upgradeLegacyReservation(path, { ...payload, checksum });
    return true;
  } catch {
    return false;
  }
}

async function upgradeLegacyReservation(path: string, reservation: PublicationGenerationReservation): Promise<void> {
  const temporary = `${path}.${randomUUID()}.migration.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, "utf8");
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

function reservationChecksum(payload: PublicationGenerationReservationPayload): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

async function readDirectoryIfPresent(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function assertStableId(value: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(value)) throw new TypeError("idempotencyKey must be a stable ID.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
