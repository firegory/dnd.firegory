import { createHash } from "node:crypto";

import {
  getPublicationSpoolRoot,
  markPublicationCompleted,
  markPublicationFailed,
  quarantinePublication,
  readOutboxState,
  PublicationCommandError,
} from "../../server/content-storage/publication-command.ts";
import {
  acknowledgePublication,
  deadLetterPublication,
  PUBLICATION_MAX_ATTEMPTS,
  retryPublication,
  type PublicationReservation,
} from "../../server/content-storage/publication-queue.ts";
import {
  ContentIntegrityError,
  ContentSchemaValidationError,
} from "../../server/content-storage/validation.ts";
import {
  PublicationFenceUnavailableError,
  PublicationLeaseUnavailableError,
  publishSpooledCommand,
} from "./publisher.ts";

type QueueActions = Readonly<{
  acknowledge: typeof acknowledgePublication;
  retry: typeof retryPublication;
  deadLetter: typeof deadLetterPublication;
}>;

export type PublicationProcessingResult = "completed" | "already-completed" | "retried" | "dead-lettered";

export async function processPublicationReservation(options: Readonly<{
  reservation: PublicationReservation;
  dataRoot: string;
  spoolRoot?: string;
  now?: number;
  publish?: typeof publishSpooledCommand;
  queue?: QueueActions;
}>): Promise<PublicationProcessingResult> {
  const spoolRoot = options.spoolRoot ?? getPublicationSpoolRoot();
  const now = options.now ?? Date.now();
  const queue = options.queue ?? {
    acknowledge: acknowledgePublication,
    retry: retryPublication,
    deadLetter: deadLetterPublication,
  };
  const { reservation } = options;

  if (!reservation.message) {
    const reason = reservation.malformedReason ?? "Malformed publication delivery.";
    await quarantinePublication(quarantineId(reservation.deliveryId), reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }

  const { idempotencyKey, attempt } = reservation.message;
  let state;
  try {
    state = await readOutboxState(spoolRoot, idempotencyKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markPublicationFailed(idempotencyKey, reason, spoolRoot, now);
    await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }
  if (state?.status === "completed") {
    await queue.acknowledge(reservation);
    return "already-completed";
  }
  if (state?.status === "failed") {
    await queue.deadLetter(reservation, state.lastError ?? "Publication was previously quarantined.", now);
    return "dead-lettered";
  }

  try {
    await (options.publish ?? publishSpooledCommand)({
      dataRoot: options.dataRoot,
      spoolRoot,
      idempotencyKey,
    });
    await markPublicationCompleted(idempotencyKey, spoolRoot, now);
    await queue.acknowledge(reservation);
    return "completed";
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (isPermanentPublicationFailure(error) || attempt + 1 >= PUBLICATION_MAX_ATTEMPTS) {
      await markPublicationFailed(idempotencyKey, reason, spoolRoot, now);
      await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
      await queue.deadLetter(reservation, reason, now);
      return "dead-lettered";
    }

    const delayMs = Math.min(60_000, 1_000 * 2 ** attempt);
    await queue.retry(reservation, { now, delayMs });
    return "retried";
  }
}

export function isPermanentPublicationFailure(error: unknown): boolean {
  if (error instanceof PublicationLeaseUnavailableError || error instanceof PublicationFenceUnavailableError) return false;
  if (error instanceof PublicationCommandError || error instanceof ContentIntegrityError || error instanceof ContentSchemaValidationError || error instanceof SyntaxError || error instanceof TypeError) {
    return true;
  }
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
  return false;
}

function quarantineId(deliveryId: string): string {
  if (/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(deliveryId)) return deliveryId;
  return `invalid-${createHash("sha256").update(deliveryId).digest("hex")}`;
}
