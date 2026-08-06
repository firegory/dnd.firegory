import type { PoolClient } from "pg";

import { assertStableId } from "../../server/content-storage/repository.ts";
import { getPool } from "../../server/db/client.ts";

export type PublicationFence = Readonly<{
  verify: () => Promise<void>;
  release: () => Promise<void>;
}>;

export interface PublicationFenceManager {
  acquire(targetId: string): Promise<PublicationFence | null>;
}

export class PostgresPublicationFenceManager implements PublicationFenceManager {
  readonly #connect: () => Promise<PoolClient>;

  constructor(connect: () => Promise<PoolClient> = () => getPool().connect()) {
    this.#connect = connect;
  }

  async acquire(targetId: string): Promise<PublicationFence | null> {
    assertStableId(targetId, "publication target");
    const client = await this.#connect();
    try {
      const result = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
        [`dnd-firegory:canonical-publication:${targetId}`],
      );
      if (!result.rows[0]?.acquired) {
        client.release();
        return null;
      }
      return postgresFence(client, targetId);
    } catch (error) {
      client.release();
      throw error;
    }
  }
}

function postgresFence(client: PoolClient, targetId: string): PublicationFence {
  let released = false;
  return {
    async verify() {
      await client.query("SELECT 1");
    },
    async release() {
      if (released) return;
      released = true;
      try {
        await client.query(
          "SELECT pg_advisory_unlock(hashtextextended($1, 0))",
          [`dnd-firegory:canonical-publication:${targetId}`],
        );
      } finally {
        client.release();
      }
    },
  };
}
