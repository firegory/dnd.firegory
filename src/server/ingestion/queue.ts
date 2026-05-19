/**
 * Redis-backed queue for ingestion jobs.
 *
 * Uses a simple LIST as a queue (LPUSH/BRPOP).
 * The queue_id in ingestion_jobs references the Redis message ID for traceability.
 */

import { createClient, type RedisClientType } from "redis";

let sharedClient: RedisClientType | null = null;

export function getRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is required for ingestion queue operations.");
  }
  return url;
}

export function getRedisClient(): RedisClientType {
  if (!sharedClient) {
    sharedClient = createClient({ url: getRedisUrl() }) as RedisClientType;
    sharedClient.on("error", (err: Error) => {
      console.error("[ingestion-queue] Redis client error:", err.message);
    });
  }
  return sharedClient;
}

/**
 * Ensures the Redis client is connected.
 */
export async function ensureRedisConnection(): Promise<void> {
  const client = getRedisClient();
  if (!client.isOpen) {
    await client.connect();
  }
}

export const INGESTION_QUEUE_KEY = "dnd_firegory:ingestion_queue";

export type QueueMessage = Readonly<{
  jobId: string;
}>;

/**
 * Enqueues an ingestion job message and returns the queue message ID.
 */
export async function enqueueJob(jobId: string): Promise<string> {
  await ensureRedisConnection();
  const client = getRedisClient();
  const message: QueueMessage = { jobId };
  const encoded = JSON.stringify(message);
  await client.lPush(INGESTION_QUEUE_KEY, encoded);
  // Use the jobId as the queue_id for traceability
  return jobId;
}

/**
 * Dequeues the next ingestion job message (blocking with timeout).
 * Returns null if no message arrives within the timeout.
 */
export async function dequeueJob(timeoutSeconds = 30): Promise<QueueMessage | null> {
  await ensureRedisConnection();
  const client = getRedisClient();
  const result = await client.brPop(INGESTION_QUEUE_KEY, timeoutSeconds);
  if (!result) return null;

  try {
    return JSON.parse(result.element) as QueueMessage;
  } catch {
    console.error("[ingestion-queue] Failed to parse queue message:", result.element);
    return null;
  }
}

/**
 * Returns the current queue length.
 */
export async function getQueueLength(): Promise<number> {
  await ensureRedisConnection();
  const client = getRedisClient();
  return client.lLen(INGESTION_QUEUE_KEY);
}
