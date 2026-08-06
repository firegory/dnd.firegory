import { mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  activationDirectoryPath,
  formatPublicationGeneration,
  parsePublicationGeneration,
  publicationGenerationReservationPath,
  publicationSpoolPath,
} from "./repository.ts";

export type PublicationGenerationReservation = Readonly<{
  schemaVersion: 1;
  kind: "publicationGenerationReservation";
  generation: string;
  idempotencyKey: string;
  reservedAt: number;
}>;

export async function reservePublicationGeneration(options: Readonly<{
  spoolRoot: string;
  dataRoot: string;
  idempotencyKey: string;
  now?: number;
  beforeCreate?: (generation: string) => void | Promise<void>;
}>): Promise<string> {
  const reservationDirectory = dirname(publicationGenerationReservationPath(options.spoolRoot, "0".repeat(32)));
  await mkdir(reservationDirectory, { recursive: true, mode: 0o750 });

  for (;;) {
    const maximum = await maximumDurableGeneration(options.spoolRoot, options.dataRoot);
    const generation = formatPublicationGeneration(maximum + BigInt(1));
    await options.beforeCreate?.(generation);
    const path = publicationGenerationReservationPath(options.spoolRoot, generation);
    try {
      const file = await open(path, "wx", 0o600);
      try {
        const reservation: PublicationGenerationReservation = {
          schemaVersion: 1,
          kind: "publicationGenerationReservation",
          generation,
          idempotencyKey: options.idempotencyKey,
          reservedAt: options.now ?? Date.now(),
        };
        await file.writeFile(`${JSON.stringify(reservation, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await syncDirectory(reservationDirectory);
      return generation;
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      // Another submitter reserved the candidate; rescan all durable identities.
    }
  }
}

export async function maximumDurableGeneration(spoolRoot: string, dataRoot: string): Promise<bigint> {
  let maximum = BigInt(0);
  const directories = [
    dirname(publicationGenerationReservationPath(spoolRoot, "0".repeat(32))),
    activationDirectoryPath(dataRoot),
  ];
  for (const directory of directories) {
    for (const name of await readDirectoryIfPresent(directory)) {
      const match = /^([0-9]{32})\.json$/.exec(name);
      if (!match) continue;
      const generation = parsePublicationGeneration(match[1]);
      if (generation > maximum) maximum = generation;
    }
  }

  const commandDirectory = dirname(publicationSpoolPath(spoolRoot, "placeholder"));
  for (const name of await readDirectoryIfPresent(commandDirectory)) {
    if (!/^[a-z0-9-]+\.json$/.test(name)) continue;
    try {
      const value = JSON.parse(await readFile(resolve(commandDirectory, name), "utf8")) as { generation?: unknown };
      if (typeof value.generation !== "string" || !/^[0-9]{32}$/.test(value.generation)) continue;
      const generation = parsePublicationGeneration(value.generation);
      if (generation > maximum) maximum = generation;
    } catch {
      // Corrupt commands are quarantined by outbox processing and cannot block allocation.
    }
  }
  return maximum;
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

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
