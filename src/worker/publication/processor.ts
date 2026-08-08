import { createHash } from "node:crypto";

import {
  getPublicationSpoolRoot,
  loadPublicationCommand,
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
  PUBLICATION_VISIBILITY_TIMEOUT_MS,
  renewPublicationReservation,
  retryPublication,
  type PublicationReservation,
} from "../../server/content-storage/publication-queue.ts";
import {
  ContentIntegrityError,
  ContentSchemaValidationError,
} from "../../server/content-storage/validation.ts";
import { recordImportReviewPublicationOutcome } from "../../server/compendium/import-review-outcomes.ts";
import {
  PublicationFenceUnavailableError,
  PublicationLeaseUnavailableError,
  publishSpooledCommand,
} from "./publisher.ts";

type QueueActions = Readonly<{
  acknowledge: typeof acknowledgePublication;
  renew: typeof renewPublicationReservation;
  retry: typeof retryPublication;
  deadLetter: typeof deadLetterPublication;
}>;

export type PublicationProcessingResult = "completed" | "already-completed" | "retried" | "dead-lettered" | "reservation-lost";

export async function processPublicationReservation(options: Readonly<{
  reservation: PublicationReservation;
  dataRoot: string;
  spoolRoot?: string;
  now?: number;
  clock?: () => number;
  visibilityTimeoutMs?: number;
  publish?: typeof publishSpooledCommand;
  queue?: QueueActions;
  recordOutcome?: typeof recordImportReviewPublicationOutcome;
}>): Promise<PublicationProcessingResult> {
  const spoolRoot = options.spoolRoot ?? getPublicationSpoolRoot();
  const now = options.now ?? Date.now();
  const queue = options.queue ?? {
    acknowledge: acknowledgePublication,
    renew: renewPublicationReservation,
    retry: retryPublication,
    deadLetter: deadLetterPublication,
  };
  const recordOutcome = options.recordOutcome ?? recordImportReviewPublicationOutcome;
  const { reservation } = options;
  const clock = options.clock ?? Date.now;
  const visibilityTimeoutMs = options.visibilityTimeoutMs ?? PUBLICATION_VISIBILITY_TIMEOUT_MS;

  if (!reservation.message) {
    const reason = reservation.malformedReason ?? "Malformed publication delivery.";
    await quarantinePublication(quarantineId(reservation.deliveryId), reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }

  if (!await queue.renew(reservation, { now: options.now ?? clock(), visibilityTimeoutMs })) {
    return "reservation-lost";
  }

  const { idempotencyKey, generation, attempt } = reservation.message;
  let command;
  try {
    command = await loadPublicationCommand(idempotencyKey, spoolRoot);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markPublicationFailed(idempotencyKey, generation, reason, spoolRoot, now);
    if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "failed", reason, null, now)) return "retried";
    await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }
  if (command.generation !== generation) {
    const reason = `Queued generation does not match publication command ${idempotencyKey}.`;
    await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }

  let state;
  try {
    state = await readOutboxState(spoolRoot, idempotencyKey);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await markPublicationFailed(idempotencyKey, generation, reason, spoolRoot, now);
    if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "failed", reason, null, now)) return "retried";
    await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }
  if (state && state.generation !== generation) {
    const reason = `Queued generation does not match outbox state ${idempotencyKey}.`;
    await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
    await queue.deadLetter(reservation, reason, now);
    return "dead-lettered";
  }
  if (state?.status === "completed") {
    if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "completed", null, command.kind === "publishCanonicalRevision" ? command.revision.revisionId : null, now)) return "retried";
    await queue.acknowledge(reservation);
    return "already-completed";
  }
  if (state?.status === "failed") {
    if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "failed", state.lastError ?? "Publication was previously quarantined.", null, now)) return "retried";
    await queue.deadLetter(reservation, state.lastError ?? "Publication was previously quarantined.", now);
    return "dead-lettered";
  }

  let reservationLost = false;
  let renewing = false;
  const renewal = setInterval(() => {
    if (renewing || reservationLost) return;
    renewing = true;
    void queue.renew(reservation, { now: clock(), visibilityTimeoutMs })
      .then((owned) => { reservationLost ||= !owned; })
      .catch(() => { reservationLost = true; })
      .finally(() => { renewing = false; });
  }, Math.max(1, Math.floor(visibilityTimeoutMs / 3)));
  renewal.unref();

  try {
    await (options.publish ?? publishSpooledCommand)({
      dataRoot: options.dataRoot,
      spoolRoot,
      idempotencyKey,
      expectedGeneration: generation,
    });
    await markPublicationCompleted(idempotencyKey, generation, spoolRoot, now);
    if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "completed", null, command.kind === "publishCanonicalRevision" ? command.revision.revisionId : null, now)) return "retried";
    if (reservationLost || !await queue.renew(reservation, { now: clock(), visibilityTimeoutMs })) {
      return "reservation-lost";
    }
    await queue.acknowledge(reservation);
    return "completed";
  } catch (error) {
    if (reservationLost || !await queue.renew(reservation, { now: clock(), visibilityTimeoutMs })) {
      return "reservation-lost";
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (error instanceof PublicationLeaseUnavailableError || error instanceof PublicationFenceUnavailableError) {
      await queue.retry(reservation, { now, delayMs: 1_000, consumeAttempt: false });
      return "retried";
    }
    if (isPermanentPublicationFailure(error) || attempt + 1 >= PUBLICATION_MAX_ATTEMPTS) {
      await markPublicationFailed(idempotencyKey, generation, reason, spoolRoot, now);
      if (!await recordOutcomeOrRetry(recordOutcome, queue, reservation, idempotencyKey, "failed", reason, null, now)) return "retried";
      await quarantinePublication(reservation.deliveryId, reservation.raw, reason, spoolRoot, now);
      await queue.deadLetter(reservation, reason, now);
      return "dead-lettered";
    }

    const delayMs = Math.min(60_000, 1_000 * 2 ** attempt);
    await queue.retry(reservation, { now, delayMs });
    return "retried";
  } finally {
    clearInterval(renewal);
  }
}

async function recordOutcomeOrRetry(
  recordOutcome: typeof recordImportReviewPublicationOutcome,
  queue: QueueActions,
  reservation: PublicationReservation,
  idempotencyKey: string,
  status: "completed" | "failed",
  reason: string | null,
  canonicalRevisionId: string | null,
  now: number,
): Promise<boolean> {
  try {
    await recordOutcome(idempotencyKey, status, reason, canonicalRevisionId);
    return true;
  } catch {
    await queue.retry(reservation, { now, delayMs: 1_000, consumeAttempt: false });
    return false;
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
