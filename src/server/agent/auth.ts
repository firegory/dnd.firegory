import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

import type { QueryResultRow } from "pg";

import type { RetrievalUser } from "../access/retrieval-filter.ts";
import type { UserRole } from "../auth/types.ts";
import { isUserRole } from "../auth/types.ts";
import { hashSessionToken } from "../auth/session-token.ts";
import { agentQuery } from "./database.ts";
import { AgentGatewayError } from "./errors.ts";

export const AGENT_TOOLS = [
  "list_entity_types",
  "list_entries",
  "get_entry",
  "resolve_alias",
  "search_entries",
  "get_source",
  "get_citations",
  "read_section",
  "list_changed_entries",
] as const;
export type AgentToolName = (typeof AGENT_TOOLS)[number];
export type AgentScope = AgentToolName | "agent:read";

export type AgentPrincipal = Readonly<{
  subject: string;
  user: RetrievalUser;
  scopes: ReadonlySet<AgentScope>;
  authentication: "token" | "session";
}>;

type TokenPolicy = Readonly<{
  id: string;
  sha256: string;
  role: UserRole;
  userId?: string;
  scopes: readonly AgentScope[];
}>;

type Queryable = Readonly<{
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: readonly unknown[]): Promise<{ rows: T[] }>;
}>;

export class AgentAuthenticator {
  private readonly tokens: readonly TokenPolicy[];
  private readonly allowSessions: boolean;
  private readonly db: Queryable;

  constructor(
    tokens: readonly TokenPolicy[],
    allowSessions = false,
    db: Queryable = { query: agentQuery },
  ) {
    this.tokens = tokens;
    this.allowSessions = allowSessions;
    this.db = db;
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env, db?: Queryable): AgentAuthenticator {
    const inline = environment.AGENT_GATEWAY_TOKENS;
    const file = environment.AGENT_GATEWAY_TOKENS_FILE;
    if (inline && file) throw new Error("AGENT_GATEWAY_TOKENS and AGENT_GATEWAY_TOKENS_FILE are mutually exclusive.");
    return new AgentAuthenticator(
      parseTokenPolicies(file ? readFileSync(file, "utf8") : inline),
      environment.AGENT_GATEWAY_ALLOW_SESSIONS === "true",
      db,
    );
  }

  async authenticate(authorization: string | null): Promise<AgentPrincipal> {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9._~-]+)$/);
    if (!match) throw new AgentGatewayError("authentication_required", "A bearer token is required.", 401);
    const presented = match[1];
    const digest = createHash("sha256").update(presented).digest("hex");
    const policy = this.tokens.find((candidate) => safeEqual(candidate.sha256, digest));
    if (policy) {
      return {
        subject: policy.id,
        user: { role: policy.role, ...(policy.userId ? { userId: policy.userId } : {}) },
        scopes: new Set(policy.scopes),
        authentication: "token",
      };
    }
    if (!this.allowSessions) throw new AgentGatewayError("authentication_required", "The bearer token is invalid.", 401);

    const result = await this.db.query<{ user_id: string; role: UserRole } & QueryResultRow>(
      `SELECT users.id AS user_id, users.role
       FROM sessions JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = $1 AND sessions.revoked_at IS NULL
         AND sessions.expires_at > now() AND users.disabled_at IS NULL
       LIMIT 1`,
      [hashSessionToken(presented)],
    );
    const session = result.rows[0];
    if (!session) throw new AgentGatewayError("authentication_required", "The bearer token is invalid.", 401);
    return {
      subject: session.user_id,
      user: { role: session.role, userId: session.user_id },
      scopes: new Set(["agent:read"]),
      authentication: "session",
    };
  }
}

export function requireToolScope(principal: AgentPrincipal, tool: AgentToolName): void {
  if (!principal.scopes.has("agent:read") && !principal.scopes.has(tool)) {
    throw new AgentGatewayError("forbidden", `Token scope does not permit ${tool}.`, 403);
  }
}

export function parseTokenPolicies(raw: string | undefined): readonly TokenPolicy[] {
  if (!raw) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("AGENT_GATEWAY_TOKENS must be valid JSON.");
  }
  if (!Array.isArray(value)) throw new Error("AGENT_GATEWAY_TOKENS must be a JSON array.");
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object") throw new Error(`Agent token policy ${index} must be an object.`);
    const record = candidate as Record<string, unknown>;
    const scopes = record.scopes;
    if (typeof record.id !== "string" || !record.id.trim()) throw new Error(`Agent token policy ${index} has an invalid id.`);
    if (typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)) {
      throw new Error(`Agent token policy ${index} has an invalid sha256 digest.`);
    }
    if (typeof record.role !== "string" || !isUserRole(record.role)) throw new Error(`Agent token policy ${index} has an invalid role.`);
    if (!Array.isArray(scopes) || scopes.some((scope) => scope !== "agent:read" && !AGENT_TOOLS.includes(scope as AgentToolName))) {
      throw new Error(`Agent token policy ${index} has invalid scopes.`);
    }
    if (record.userId !== undefined && (typeof record.userId !== "string" || !record.userId.trim())) {
      throw new Error(`Agent token policy ${index} has an invalid userId.`);
    }
    return {
      id: record.id,
      sha256: record.sha256,
      role: record.role,
      ...(typeof record.userId === "string" ? { userId: record.userId } : {}),
      scopes: scopes as AgentScope[],
    };
  });
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
