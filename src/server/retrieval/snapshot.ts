import type { QueryResult, QueryResultRow } from "pg";

import { query } from "../db/client.ts";

export type RetrievalSnapshot = Readonly<{
  generationIds: readonly string[];
}>;

type QueryExecutor = <T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: readonly unknown[],
) => Promise<QueryResult<T>>;

export async function captureRetrievalSnapshot(
  accessSql: string,
  accessParams: readonly unknown[],
  execute: QueryExecutor = query,
): Promise<RetrievalSnapshot> {
  const result = await execute<{ generation_id: string }>(
    `SELECT f.active_generation_id AS generation_id
     FROM files f
     JOIN sources s ON s.id = f.source_id
     WHERE f.active_generation_id IS NOT NULL
       AND f.deleted_at IS NULL
       AND s.deleted_at IS NULL
       AND ${accessSql}
     ORDER BY f.id`,
    accessParams,
  );
  return { generationIds: result.rows.map((row) => row.generation_id) };
}
