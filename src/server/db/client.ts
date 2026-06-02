import { Pool, type PoolClient as PoolClientType, type QueryResult, type QueryResultRow } from "pg";

export type PoolClient = PoolClientType;

let pool: Pool | undefined;

function getDatabaseUrl(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for database-backed server operations.");
  }
  return databaseUrl;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getDatabaseUrl() });
  }
  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, [...params]);
}

export async function withTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
