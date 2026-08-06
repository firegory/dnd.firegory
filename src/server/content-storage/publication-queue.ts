import { randomUUID } from "node:crypto";

import { ensureRedisConnection, getRedisClient } from "../ingestion/queue.ts";
import { assertStableId } from "./repository.ts";

export const PUBLICATION_READY_KEY = "dnd_firegory:publication:ready";
export const PUBLICATION_PROCESSING_KEY = "dnd_firegory:publication:processing";
export const PUBLICATION_DELIVERIES_KEY = "dnd_firegory:publication:deliveries";
export const PUBLICATION_RESERVATIONS_KEY = "dnd_firegory:publication:reservations";
export const PUBLICATION_DEAD_LETTER_KEY = "dnd_firegory:publication:dead_letter";

export const PUBLICATION_VISIBILITY_TIMEOUT_MS = 60_000;
export const PUBLICATION_MAX_ATTEMPTS = 5;

export type PublicationQueueMessage = Readonly<{
  deliveryId: string;
  idempotencyKey: string;
  attempt: number;
  createdAt: number;
}>;

export type PublicationReservation = Readonly<{
  deliveryId: string;
  reservationId: string;
  raw: string;
  message: PublicationQueueMessage | null;
  malformedReason?: string;
}>;

export interface PublicationQueueBackend {
  enqueue(message: PublicationQueueMessage, availableAt: number): Promise<void>;
  reserve(now: number, deadline: number, reservationId: string): Promise<readonly [string, string] | null>;
  acknowledge(deliveryId: string, reservationId: string): Promise<boolean>;
  renew(deliveryId: string, reservationId: string, deadline: number): Promise<boolean>;
  retry(deliveryId: string, reservationId: string, availableAt: number, raw: string): Promise<boolean>;
  reclaim(now: number): Promise<number>;
  deadLetter(deliveryId: string, reservationId: string, reason: string, now: number): Promise<boolean>;
}

const RESERVE_SCRIPT = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 1)
if #ids == 0 then return nil end
local id = ids[1]
redis.call("ZREM", KEYS[1], id)
local raw = redis.call("HGET", KEYS[2], id) or ""
redis.call("ZADD", KEYS[3], ARGV[2], id)
redis.call("HSET", KEYS[4], id, ARGV[3])
return {id, raw}`;

const ACK_SCRIPT = `
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("HDEL", KEYS[3], ARGV[1])
return 1`;

const RENEW_RESERVATION_SCRIPT = `
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
if redis.call("ZSCORE", KEYS[2], ARGV[1]) == false then return 0 end
redis.call("ZADD", KEYS[2], ARGV[3], ARGV[1])
return 1`;

const RETRY_SCRIPT = `
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("HSET", KEYS[3], ARGV[1], ARGV[4])
redis.call("ZADD", KEYS[4], ARGV[3], ARGV[1])
return 1`;

const RECLAIM_SCRIPT = `
local ids = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", ARGV[1], "LIMIT", 0, 100)
for _, id in ipairs(ids) do
  redis.call("ZREM", KEYS[1], id)
  redis.call("HDEL", KEYS[2], id)
  local raw = redis.call("HGET", KEYS[3], id)
  if raw then
    local decoded, body = pcall(cjson.decode, raw)
    if decoded and type(body) == "table" and type(body.attempt) == "number" then
      body.attempt = body.attempt + 1
      redis.call("HSET", KEYS[3], id, cjson.encode(body))
    end
    redis.call("ZADD", KEYS[4], ARGV[1], id)
  end
end
return #ids`;

const DEAD_LETTER_SCRIPT = `
if redis.call("HGET", KEYS[1], ARGV[1]) ~= ARGV[2] then return 0 end
local raw = redis.call("HGET", KEYS[3], ARGV[1]) or ""
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("HDEL", KEYS[3], ARGV[1])
redis.call("LPUSH", KEYS[4], cjson.encode({deliveryId=ARGV[1], body=raw, reason=ARGV[3], failedAt=ARGV[4]}))
return 1`;

export async function enqueuePublication(
  idempotencyKey: string,
  options: Readonly<{ now?: number; delayMs?: number; backend?: PublicationQueueBackend }> = {},
): Promise<PublicationQueueMessage> {
  assertStableId(idempotencyKey, "idempotencyKey");
  const now = options.now ?? Date.now();
  const message: PublicationQueueMessage = {
    deliveryId: randomUUID(),
    idempotencyKey,
    attempt: 0,
    createdAt: now,
  };
  await (options.backend ?? redisBackend).enqueue(message, now + (options.delayMs ?? 0));
  return message;
}

export async function reservePublication(
  options: Readonly<{ now?: number; visibilityTimeoutMs?: number; backend?: PublicationQueueBackend }> = {},
): Promise<PublicationReservation | null> {
  const now = options.now ?? Date.now();
  const reservationId = randomUUID();
  const result = await (options.backend ?? redisBackend).reserve(
    now,
    now + (options.visibilityTimeoutMs ?? PUBLICATION_VISIBILITY_TIMEOUT_MS),
    reservationId,
  );
  if (result === null) return null;
  const deliveryId = result[0];
  const raw = result[1];
  try {
    return { deliveryId, reservationId, raw, message: decodeMessage(raw, deliveryId) };
  } catch (error) {
    return {
      deliveryId,
      reservationId,
      raw,
      message: null,
      malformedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function acknowledgePublication(
  reservation: PublicationReservation,
  backend: PublicationQueueBackend = redisBackend,
): Promise<boolean> {
  return backend.acknowledge(reservation.deliveryId, reservation.reservationId);
}

export async function renewPublicationReservation(
  reservation: PublicationReservation,
  options: Readonly<{
    now?: number;
    visibilityTimeoutMs?: number;
    backend?: PublicationQueueBackend;
  }> = {},
): Promise<boolean> {
  const now = options.now ?? Date.now();
  return (options.backend ?? redisBackend).renew(
    reservation.deliveryId,
    reservation.reservationId,
    now + (options.visibilityTimeoutMs ?? PUBLICATION_VISIBILITY_TIMEOUT_MS),
  );
}

export async function retryPublication(
  reservation: PublicationReservation,
  options: Readonly<{
    now?: number;
    delayMs: number;
    consumeAttempt?: boolean;
    backend?: PublicationQueueBackend;
  }>,
): Promise<boolean> {
  if (!reservation.message) return false;
  const nextMessage = {
    ...reservation.message,
    attempt: reservation.message.attempt + (options.consumeAttempt === false ? 0 : 1),
  };
  return (options.backend ?? redisBackend).retry(
    reservation.deliveryId,
    reservation.reservationId,
    (options.now ?? Date.now()) + options.delayMs,
    JSON.stringify(nextMessage),
  );
}

export async function reclaimExpiredPublications(
  now = Date.now(),
  backend: PublicationQueueBackend = redisBackend,
): Promise<number> {
  return backend.reclaim(now);
}

export async function deadLetterPublication(
  reservation: PublicationReservation,
  reason: string,
  now = Date.now(),
  backend: PublicationQueueBackend = redisBackend,
): Promise<boolean> {
  return backend.deadLetter(reservation.deliveryId, reservation.reservationId, reason, now);
}

const redisBackend: PublicationQueueBackend = {
  async enqueue(message, availableAt) {
    await ensureRedisConnection();
    await getRedisClient()
      .multi()
      .hSet(PUBLICATION_DELIVERIES_KEY, message.deliveryId, JSON.stringify(message))
      .zAdd(PUBLICATION_READY_KEY, [{ score: availableAt, value: message.deliveryId }])
      .exec();
  },
  async reserve(now, deadline, reservationId) {
    await ensureRedisConnection();
    const result = await getRedisClient().eval(RESERVE_SCRIPT, {
      keys: [PUBLICATION_READY_KEY, PUBLICATION_DELIVERIES_KEY, PUBLICATION_PROCESSING_KEY, PUBLICATION_RESERVATIONS_KEY],
      arguments: [String(now), String(deadline), reservationId],
    });
    if (result === null) return null;
    if (!Array.isArray(result) || typeof result[0] !== "string" || typeof result[1] !== "string") {
      throw new Error("Redis returned an invalid publication reservation.");
    }
    return [result[0], result[1]];
  },
  async acknowledge(deliveryId, reservationId) {
    await ensureRedisConnection();
    return Number(await getRedisClient().eval(ACK_SCRIPT, {
      keys: [PUBLICATION_RESERVATIONS_KEY, PUBLICATION_PROCESSING_KEY, PUBLICATION_DELIVERIES_KEY],
      arguments: [deliveryId, reservationId],
    })) === 1;
  },
  async renew(deliveryId, reservationId, deadline) {
    await ensureRedisConnection();
    return Number(await getRedisClient().eval(RENEW_RESERVATION_SCRIPT, {
      keys: [PUBLICATION_RESERVATIONS_KEY, PUBLICATION_PROCESSING_KEY],
      arguments: [deliveryId, reservationId, String(deadline)],
    })) === 1;
  },
  async retry(deliveryId, reservationId, availableAt, raw) {
    await ensureRedisConnection();
    return Number(await getRedisClient().eval(RETRY_SCRIPT, {
      keys: [PUBLICATION_RESERVATIONS_KEY, PUBLICATION_PROCESSING_KEY, PUBLICATION_DELIVERIES_KEY, PUBLICATION_READY_KEY],
      arguments: [deliveryId, reservationId, String(availableAt), raw],
    })) === 1;
  },
  async reclaim(now) {
    await ensureRedisConnection();
    return Number(await getRedisClient().eval(RECLAIM_SCRIPT, {
      keys: [PUBLICATION_PROCESSING_KEY, PUBLICATION_RESERVATIONS_KEY, PUBLICATION_DELIVERIES_KEY, PUBLICATION_READY_KEY],
      arguments: [String(now)],
    }));
  },
  async deadLetter(deliveryId, reservationId, reason, now) {
    await ensureRedisConnection();
    return Number(await getRedisClient().eval(DEAD_LETTER_SCRIPT, {
      keys: [PUBLICATION_RESERVATIONS_KEY, PUBLICATION_PROCESSING_KEY, PUBLICATION_DELIVERIES_KEY, PUBLICATION_DEAD_LETTER_KEY],
      arguments: [deliveryId, reservationId, reason, String(now)],
    })) === 1;
  },
};

function decodeMessage(raw: string, deliveryId: string): PublicationQueueMessage {
  const value: unknown = JSON.parse(raw);
  if (
    !isRecord(value) ||
    value.deliveryId !== deliveryId ||
    typeof value.idempotencyKey !== "string" ||
    !Number.isSafeInteger(value.attempt) ||
    (value.attempt as number) < 0 ||
    !Number.isSafeInteger(value.createdAt)
  ) {
    throw new Error("Publication delivery body is malformed.");
  }
  assertStableId(deliveryId, "deliveryId");
  assertStableId(value.idempotencyKey, "idempotencyKey");
  return value as PublicationQueueMessage;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
