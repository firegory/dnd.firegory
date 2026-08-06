import { randomUUID } from "node:crypto";

import { ensureRedisConnection, getRedisClient } from "../../server/ingestion/queue.ts";
import { assertStableId } from "../../server/content-storage/repository.ts";

const RENEW_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0`;

export type PublicationLease = Readonly<{
  ownerId: string;
  renew: () => Promise<boolean>;
  release: () => Promise<boolean>;
}>;

export interface PublicationLeaseManager {
  acquire(targetId: string, ttlMs: number): Promise<PublicationLease | null>;
}

type LeaseCommands = Readonly<{
  acquire: (key: string, ownerId: string, ttlMs: number) => Promise<boolean>;
  renew: (key: string, ownerId: string, ttlMs: number) => Promise<boolean>;
  release: (key: string, ownerId: string) => Promise<boolean>;
}>;

export class RedisPublicationLeaseManager implements PublicationLeaseManager {
  readonly #commands: LeaseCommands;

  constructor(commands: LeaseCommands = redisLeaseCommands()) {
    this.#commands = commands;
  }

  async acquire(targetId: string, ttlMs: number): Promise<PublicationLease | null> {
    assertStableId(targetId, "publication target");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError("Lease TTL must be a positive integer.");
    const key = `dnd_firegory:publication_lease:${targetId}`;
    const ownerId = randomUUID();
    if (!await this.#commands.acquire(key, ownerId, ttlMs)) return null;
    return {
      ownerId,
      renew: () => this.#commands.renew(key, ownerId, ttlMs),
      release: () => this.#commands.release(key, ownerId),
    };
  }
}

function redisLeaseCommands(): LeaseCommands {
  return {
    async acquire(key, ownerId, ttlMs) {
      await ensureRedisConnection();
      return await getRedisClient().set(key, ownerId, { NX: true, PX: ttlMs }) === "OK";
    },
    async renew(key, ownerId, ttlMs) {
      await ensureRedisConnection();
      return Number(await getRedisClient().eval(RENEW_SCRIPT, {
        keys: [key],
        arguments: [ownerId, String(ttlMs)],
      })) === 1;
    },
    async release(key, ownerId) {
      await ensureRedisConnection();
      return Number(await getRedisClient().eval(RELEASE_SCRIPT, {
        keys: [key],
        arguments: [ownerId],
      })) === 1;
    },
  };
}
