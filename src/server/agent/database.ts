import { Pool, type QueryResultRow } from "pg";

import { readConfig } from "./config.ts";

let pool: Pool | undefined;

export function agentQuery<T extends QueryResultRow = QueryResultRow>(text: string, values: readonly unknown[] = []) {
  return getAgentPool().query<T>(text, [...values]);
}

function getAgentPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: readConfig("DATABASE_URL", "DATABASE_URL_FILE"),
      application_name: "dnd-firegory-agent-gateway",
      max: positiveInteger(process.env.AGENT_GATEWAY_DB_POOL_SIZE, 8, 32),
      connectionTimeoutMillis: positiveInteger(process.env.AGENT_GATEWAY_DB_CONNECT_TIMEOUT_MS, 3_000, 30_000),
      statement_timeout: positiveInteger(process.env.AGENT_GATEWAY_DB_STATEMENT_TIMEOUT_MS, 5_000, 60_000),
      query_timeout: positiveInteger(process.env.AGENT_GATEWAY_DB_QUERY_TIMEOUT_MS, 6_000, 65_000),
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

function positiveInteger(raw: string | undefined, fallback: number, maximum: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`Agent database timeout/pool setting must be an integer from 1 to ${maximum}.`);
  return value;
}
