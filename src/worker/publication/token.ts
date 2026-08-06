import type { PoolClient } from "pg";

import { getPool } from "../../server/db/client.ts";

export interface ActivationTokenAllocator {
  allocate(minimumExclusive: bigint): Promise<bigint>;
}

export class PostgresActivationTokenAllocator implements ActivationTokenAllocator {
  readonly #client: PoolClient;

  constructor(client: PoolClient) {
    this.#client = client;
  }

  async allocate(minimumExclusive: bigint): Promise<bigint> {
    await this.#client.query("BEGIN");
    try {
      await this.#client.query("SELECT pg_advisory_xact_lock(hashtextextended('dnd-firegory:activation-token', 0))");
      const first = await this.#client.query<{ token: string }>(
        "SELECT nextval('publication_fencing_token_seq')::text AS token",
      );
      let token = BigInt(first.rows[0].token);
      if (token <= minimumExclusive) {
        await this.#client.query(
          "SELECT setval('publication_fencing_token_seq', $1::bigint, true)",
          [minimumExclusive.toString()],
        );
        const advanced = await this.#client.query<{ token: string }>(
          "SELECT nextval('publication_fencing_token_seq')::text AS token",
        );
        token = BigInt(advanced.rows[0].token);
      }
      if (token <= minimumExclusive) throw new Error("PostgreSQL did not advance the publication fencing token.");
      await this.#client.query("COMMIT");
      return token;
    } catch (error) {
      await this.#client.query("ROLLBACK");
      throw error;
    }
  }
}

export async function createPostgresActivationTokenAllocator(): Promise<Readonly<{
  allocator: ActivationTokenAllocator;
  release: () => void;
}>> {
  const client = await getPool().connect();
  return {
    allocator: new PostgresActivationTokenAllocator(client),
    release: () => client.release(),
  };
}
