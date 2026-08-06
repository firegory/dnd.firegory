import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { enqueuePublication } from "./publication-queue.ts";
import {
  canonicalJson,
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

export function getPublicationSpoolRoot(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PUBLICATION_SPOOL_ROOT?.trim();
  const storageRoot = environment.STORAGE_ROOT?.trim() || "./storage";
  return resolve(configured || resolve(storageRoot, "publication-spool"));
}

export async function submitPublicationCommand(
  input: Readonly<{ idempotencyKey: string; revision: CanonicalRevision }>,
  options: Readonly<{
    spoolRoot?: string;
    enqueue?: (idempotencyKey: string) => Promise<void>;
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

  await mkdir(dirname(commandPath), { recursive: true });
  const temporaryPath = `${commandPath}.${randomUUID()}.tmp`;
  let existing = false;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(encoded, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await link(temporaryPath, commandPath);
    } catch (error) {
      if (!hasCode(error, "EEXIST")) throw error;
      existing = true;
      if (await readFile(commandPath, "utf8") !== encoded) {
        throw new Error(`Idempotency key ${input.idempotencyKey} is already bound to another publication.`);
      }
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }

  await (options.enqueue ?? enqueuePublication)(input.idempotencyKey);
  return { commandPath, existing };
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
    throw new Error(`Publication command ${idempotencyKey} is invalid.`);
  }
  assertCanonicalRevision(value.revision);
  return value as PublicationCommand;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
