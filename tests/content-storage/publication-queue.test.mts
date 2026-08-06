import assert from "node:assert/strict";
import test from "node:test";

import {
  acknowledgePublication,
  deadLetterPublication,
  enqueuePublication,
  reclaimExpiredPublications,
  renewPublicationReservation,
  reservePublication,
  retryPublication,
  type PublicationQueueBackend,
  type PublicationQueueMessage,
} from "../../src/server/content-storage/publication-queue.ts";

test("queue reservations use unique deliveries and only the current owner can acknowledge", async () => {
  const backend = memoryQueueBackend();
  const firstDelivery = await enqueuePublication("same-command", { backend, now: 10 });
  const secondDelivery = await enqueuePublication("same-command", { backend, now: 10 });
  assert.notEqual(firstDelivery.deliveryId, secondDelivery.deliveryId);

  const first = await reservePublication({ backend, now: 10, visibilityTimeoutMs: 100 });
  assert.ok(first?.message);
  const liveDuplicate = await reservePublication({ backend, now: 10, visibilityTimeoutMs: 200 });
  assert.ok(liveDuplicate?.message);
  assert.equal(await acknowledgePublication({ ...first, reservationId: "stale-owner" }, backend), false);
  assert.equal(await renewPublicationReservation({ ...first, reservationId: "stale-owner" }, { backend, now: 100, visibilityTimeoutMs: 100 }), false);
  assert.equal(await renewPublicationReservation(first, { backend, now: 100, visibilityTimeoutMs: 100 }), true);
  assert.equal(await reclaimExpiredPublications(199, backend), 0, "renewed reservations are not reclaimed");
  assert.equal(await reclaimExpiredPublications(200, backend), 1);

  const recovered = await reservePublication({ backend, now: 200, visibilityTimeoutMs: 100 });
  assert.ok(recovered);
  assert.equal(recovered.deliveryId, first.deliveryId);
  assert.notEqual(recovered.reservationId, first.reservationId);
  assert.equal(recovered.message?.attempt, 1, "crashed reservations consume a bounded attempt");
  assert.equal(await acknowledgePublication(first, backend), false, "expired reservation cannot ack recovered work");
  assert.equal(await acknowledgePublication(recovered, backend), true);

  assert.equal(liveDuplicate.message.idempotencyKey, "same-command");
  assert.equal(await acknowledgePublication(liveDuplicate, backend), true);
});

test("retry increments attempts, respects backoff, and malformed bodies can be removed", async () => {
  const backend = memoryQueueBackend();
  await enqueuePublication("retry-command", { backend, now: 0 });
  const reserved = await reservePublication({ backend, now: 0 });
  assert.ok(reserved?.message);
  assert.equal(await retryPublication(reserved, { backend, now: 0, delayMs: 50 }), true);
  assert.equal(await reservePublication({ backend, now: 49 }), null);
  const retried = await reservePublication({ backend, now: 50 });
  assert.ok(retried?.message);
  assert.equal(retried.message.attempt, 1);
  assert.equal(await acknowledgePublication(retried, backend), true);

  await enqueuePublication("contention-command", { backend, now: 50 });
  const contended = await reservePublication({ backend, now: 50 });
  assert.ok(contended?.message);
  assert.equal(await retryPublication(contended, { backend, now: 50, delayMs: 10, consumeAttempt: false }), true);
  const contentionRetry = await reservePublication({ backend, now: 60 });
  assert.equal(contentionRetry?.message?.attempt, 0);
  assert.ok(contentionRetry);
  await acknowledgePublication(contentionRetry, backend);

  backend.putRaw("malformed-delivery", "{not-json", 60);
  const malformed = await reservePublication({ backend, now: 60 });
  assert.ok(malformed);
  assert.equal(malformed.message, null);
  assert.match(malformed.malformedReason ?? "", /JSON/);
  assert.equal(await deadLetterPublication(malformed, "malformed", 60, backend), true);
  assert.equal(backend.deadLetters.length, 1);
  assert.equal(await reclaimExpiredPublications(1_000_000, backend), 0);
});

function memoryQueueBackend() {
  const deliveries = new Map<string, string>();
  const ready = new Map<string, number>();
  const processing = new Map<string, number>();
  const reservations = new Map<string, string>();
  const deadLetters: Array<{ deliveryId: string; reason: string }> = [];

  const backend: PublicationQueueBackend & {
    putRaw: (deliveryId: string, raw: string, availableAt: number) => void;
    deadLetters: typeof deadLetters;
  } = {
    deadLetters,
    putRaw(deliveryId, raw, availableAt) {
      deliveries.set(deliveryId, raw);
      ready.set(deliveryId, availableAt);
    },
    async enqueue(message: PublicationQueueMessage, availableAt: number) {
      deliveries.set(message.deliveryId, JSON.stringify(message));
      ready.set(message.deliveryId, availableAt);
    },
    async reserve(now, deadline, reservationId) {
      const candidate = [...ready.entries()]
        .filter(([, availableAt]) => availableAt <= now)
        .sort((left, right) => left[1] - right[1] || left[0].localeCompare(right[0]))[0];
      if (!candidate) return null;
      const [deliveryId] = candidate;
      ready.delete(deliveryId);
      processing.set(deliveryId, deadline);
      reservations.set(deliveryId, reservationId);
      return [deliveryId, deliveries.get(deliveryId) ?? ""] as const;
    },
    async acknowledge(deliveryId, reservationId) {
      if (reservations.get(deliveryId) !== reservationId) return false;
      reservations.delete(deliveryId);
      processing.delete(deliveryId);
      deliveries.delete(deliveryId);
      return true;
    },
    async renew(deliveryId, reservationId, deadline) {
      if (reservations.get(deliveryId) !== reservationId || !processing.has(deliveryId)) return false;
      processing.set(deliveryId, deadline);
      return true;
    },
    async retry(deliveryId, reservationId, availableAt, raw) {
      if (reservations.get(deliveryId) !== reservationId) return false;
      reservations.delete(deliveryId);
      processing.delete(deliveryId);
      deliveries.set(deliveryId, raw);
      ready.set(deliveryId, availableAt);
      return true;
    },
    async reclaim(now) {
      let reclaimed = 0;
      for (const [deliveryId, deadline] of processing) {
        if (deadline > now) continue;
        processing.delete(deliveryId);
        reservations.delete(deliveryId);
        const raw = deliveries.get(deliveryId);
        if (raw !== undefined) {
          try {
            const body = JSON.parse(raw) as PublicationQueueMessage;
            deliveries.set(deliveryId, JSON.stringify({ ...body, attempt: body.attempt + 1 }));
          } catch {
            // Malformed bodies remain reclaimable so a worker can dead-letter them.
          }
          ready.set(deliveryId, now);
        }
        reclaimed++;
      }
      return reclaimed;
    },
    async deadLetter(deliveryId, reservationId, reason) {
      if (reservations.get(deliveryId) !== reservationId) return false;
      reservations.delete(deliveryId);
      processing.delete(deliveryId);
      deliveries.delete(deliveryId);
      deadLetters.push({ deliveryId, reason });
      return true;
    },
  };
  return backend;
}
