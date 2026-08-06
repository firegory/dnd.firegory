import type { RedisClientType } from "redis";

import { ensureRedisConnection, getRedisClient } from "../ingestion/queue.ts";
import { assertStableId } from "./repository.ts";

export const PUBLICATION_QUEUE_KEY = "dnd_firegory:publication_queue";
export const PUBLICATION_PROCESSING_KEY = "dnd_firegory:publication_processing";

export type PublicationQueueMessage = Readonly<{ idempotencyKey: string }>;

function encodeMessage(idempotencyKey: string): string {
  assertStableId(idempotencyKey, "idempotencyKey");
  return JSON.stringify({ idempotencyKey } satisfies PublicationQueueMessage);
}

export async function enqueuePublication(idempotencyKey: string): Promise<void> {
  await ensureRedisConnection();
  await getRedisClient().lPush(PUBLICATION_QUEUE_KEY, encodeMessage(idempotencyKey));
}

export async function dequeuePublication(): Promise<PublicationQueueMessage | null> {
  await ensureRedisConnection();
  const encoded = await getRedisClient().rPopLPush(PUBLICATION_QUEUE_KEY, PUBLICATION_PROCESSING_KEY);
  if (!encoded) return null;
  return decodeMessage(encoded);
}

export async function acknowledgePublication(message: PublicationQueueMessage): Promise<void> {
  await ensureRedisConnection();
  await getRedisClient().lRem(PUBLICATION_PROCESSING_KEY, 1, encodeMessage(message.idempotencyKey));
}

export async function retryPublication(message: PublicationQueueMessage): Promise<void> {
  await ensureRedisConnection();
  const client = getRedisClient();
  const encoded = encodeMessage(message.idempotencyKey);
  await client.eval(
    `if redis.call("LREM", KEYS[1], 1, ARGV[1]) == 1 then
       return redis.call("LPUSH", KEYS[2], ARGV[1])
     end
     return 0`,
    {
      keys: [PUBLICATION_PROCESSING_KEY, PUBLICATION_QUEUE_KEY],
      arguments: [encoded],
    },
  );
}

export async function recoverPublicationCommands(client: RedisClientType = getRedisClient()): Promise<number> {
  await ensureRedisConnection();
  let recovered = 0;
  while (await client.rPopLPush(PUBLICATION_PROCESSING_KEY, PUBLICATION_QUEUE_KEY)) recovered++;
  return recovered;
}

function decodeMessage(encoded: string): PublicationQueueMessage {
  let value: unknown;
  try {
    value = JSON.parse(encoded);
  } catch {
    throw new Error("Publication queue message is not valid JSON.");
  }
  if (!isRecord(value) || typeof value.idempotencyKey !== "string") {
    throw new Error("Publication queue message does not contain an idempotency key.");
  }
  assertStableId(value.idempotencyKey, "idempotencyKey");
  return { idempotencyKey: value.idempotencyKey };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
