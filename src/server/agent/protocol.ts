import { randomUUID } from "node:crypto";

import {
  AGENT_TOOLS,
  type AgentPrincipal,
  type AgentToolName,
  AgentAuthenticator,
  requireToolScope,
} from "./auth.ts";
import { AgentGatewayError, invalidRequest } from "./errors.ts";
import { AgentReadService, type AgentSelection, type PageInput } from "./service.ts";
import {
  SOURCE_CATEGORIES,
  SOURCE_EDITIONS,
  SOURCE_LANGUAGES,
  type RetrievalSelection,
} from "../access/retrieval-filter.ts";

export const AGENT_API_VERSION = "1";
export const AGENT_VERSION_HEADER = "Agent-API-Version";
export const MCP_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

type ToolArguments = Readonly<Record<string, unknown>>;
type AgentOperations = Pick<AgentReadService,
  | "health"
  | "listEntityTypes"
  | "listEntries"
  | "getEntry"
  | "resolveAlias"
  | "searchEntries"
  | "getSource"
  | "getCitations"
  | "readSection"
  | "listChangedEntries"
>;

export class AgentProtocol {
  private readonly service: AgentOperations;
  private readonly authenticator: AgentAuthenticator;

  constructor(
    service: AgentOperations = new AgentReadService(),
    authenticator = AgentAuthenticator.fromEnvironment(),
  ) {
    this.service = service;
    this.authenticator = authenticator;
  }

  async handle(request: Request): Promise<Response> {
    const requestId = request.headers.get("x-request-id")?.slice(0, 128) || randomUUID();
    try {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") return await this.health(requestId);
      if (url.pathname === "/mcp") return await this.mcp(request, requestId);
      if (!url.pathname.startsWith("/v1/")) throw new AgentGatewayError("not_found", "Route not found.", 404);
      negotiateHttpVersion(request.headers.get(AGENT_VERSION_HEADER));
      const principal = await this.authenticator.authenticate(request.headers.get("authorization"));
      return await this.http(request, url, principal, requestId);
    } catch (error) {
      return errorResponse(error, requestId);
    }
  }

  private async health(requestId: string): Promise<Response> {
    try {
      await this.service.health();
      return json({ status: "ok", version: AGENT_API_VERSION }, 200, requestId);
    } catch {
      return json({ status: "unavailable", version: AGENT_API_VERSION }, 503, requestId);
    }
  }

  private async http(request: Request, url: URL, principal: AgentPrincipal, requestId: string): Promise<Response> {
    if (request.method !== "GET") throw new AgentGatewayError("invalid_request", "HTTP v1 is read-only and accepts GET requests only.", 405);
    const path = url.pathname;
    let tool: AgentToolName;
    let args: ToolArguments;

    if (path === "/v1/entity-types") [tool, args] = ["list_entity_types", queryArguments(url)];
    else if (path === "/v1/entries") [tool, args] = ["list_entries", queryArguments(url)];
    else if (path === "/v1/search") [tool, args] = ["search_entries", queryArguments(url)];
    else if (path === "/v1/changes") [tool, args] = ["list_changed_entries", queryArguments(url)];
    else {
      const parts = path.split("/").filter(Boolean).map(decodePathPart);
      if (parts.length === 3 && parts[1] === "aliases") [tool, args] = ["resolve_alias", { ...queryArguments(url), alias: parts[2] }];
      else if (parts.length === 3 && parts[1] === "sources") [tool, args] = ["get_source", { ...queryArguments(url), sourceId: parts[2] }];
      else if (parts.length === 3 && parts[1] === "entries") [tool, args] = ["get_entry", { ...queryArguments(url), identifier: parts[2] }];
      else if (parts.length === 4 && parts[1] === "entries" && parts[3] === "citations") {
        [tool, args] = ["get_citations", { ...queryArguments(url), identifier: parts[2] }];
      } else if (parts.length === 5 && parts[1] === "entries" && parts[3] === "sections") {
        [tool, args] = ["read_section", { ...queryArguments(url), identifier: parts[2], sectionId: parts[4] }];
      } else throw new AgentGatewayError("not_found", "Route not found.", 404);
    }

    const data = await this.callTool(tool, args, principal);
    return json({ data, meta: { version: AGENT_API_VERSION } }, 200, requestId);
  }

  private async mcp(request: Request, requestId: string): Promise<Response> {
    if (request.method !== "POST") throw new AgentGatewayError("invalid_request", "MCP accepts POST requests only.", 405);
    const principal = await this.authenticator.authenticate(request.headers.get("authorization"));
    let rpc: Record<string, unknown>;
    try {
      rpc = await request.json() as Record<string, unknown>;
    } catch {
      return mcpError(null, -32700, "Parse error", "invalid_request", requestId);
    }
    const id = rpc.id ?? null;
    if (rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return mcpError(id, -32600, "Invalid Request", "invalid_request", requestId);
    }
    if (rpc.method.startsWith("notifications/")) return new Response(null, { status: 202, headers: responseHeaders(requestId) });
    try {
      if (rpc.method === "initialize") {
        const params = isRecord(rpc.params) ? rpc.params : {};
        const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : MCP_PROTOCOL_VERSIONS[0];
        if (!MCP_PROTOCOL_VERSIONS.includes(requested as never)) {
          return mcpError(id, -32602, "Unsupported MCP protocol version", "unsupported_version", requestId, {
            supported: MCP_PROTOCOL_VERSIONS,
          });
        }
        return mcpResult(id, {
          protocolVersion: requested,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "dnd-firegory-agent-gateway", version: AGENT_API_VERSION },
          instructions: "Read-only, source-authorized compendium access. No write tools are available.",
        }, requestId);
      }
      negotiateMcpVersion(request.headers.get("mcp-protocol-version"));
      if (rpc.method === "tools/list") {
        return mcpResult(id, { tools: toolDefinitions().filter((tool) => canUseTool(principal, tool.name)) }, requestId);
      }
      if (rpc.method === "tools/call") {
        const params = isRecord(rpc.params) ? rpc.params : {};
        if (typeof params.name !== "string" || !AGENT_TOOLS.includes(params.name as AgentToolName)) {
          throw invalidRequest("Unknown tool name.");
        }
        const name = params.name as AgentToolName;
        const result = await this.callTool(name, isRecord(params.arguments) ? params.arguments : {}, principal);
        return mcpResult(id, {
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        }, requestId);
      }
      return mcpError(id, -32601, "Method not found", "not_found", requestId);
    } catch (error) {
      const machine = normalizeError(error);
      return mcpResult(id, {
        content: [{ type: "text", text: machine.message }],
        structuredContent: { error: machine },
        isError: true,
      }, requestId);
    }
  }

  private async callTool(name: AgentToolName, args: ToolArguments, principal: AgentPrincipal): Promise<unknown> {
    requireToolScope(principal, name);
    const selection = parseSelection(args);
    const page = parsePage(args);
    switch (name) {
      case "list_entity_types": return this.service.listEntityTypes(principal.user, selection);
      case "list_entries": return this.service.listEntries(principal.user, { ...selection, ...page, entryType: optionalString(args.entryType) });
      case "get_entry": return this.service.getEntry(principal.user, requiredString(args.identifier, "identifier"), selection);
      case "resolve_alias": return this.service.resolveAlias(principal.user, requiredString(args.alias, "alias"), selection);
      case "search_entries": return this.service.searchEntries(principal.user, {
        ...selection, ...page, query: requiredString(args.query, "query"), entryType: optionalString(args.entryType),
      });
      case "get_source": return this.service.getSource(principal.user, requiredString(args.sourceId, "sourceId"), selection);
      case "get_citations": return this.service.getCitations(principal.user, requiredString(args.identifier, "identifier"), selection);
      case "read_section": return this.service.readSection(principal.user, requiredString(args.identifier, "identifier"), requiredString(args.sectionId, "sectionId"), selection);
      case "list_changed_entries": return this.service.listChangedEntries(principal.user, {
        ...selection, ...page, since: requiredString(args.since, "since"),
      });
    }
  }
}

function queryArguments(url: URL): ToolArguments {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) result[key] = key === "limit" ? Number(value) : value;
  return result;
}

function parseSelection(args: ToolArguments): AgentSelection {
  const edition = optionalString(args.edition);
  const language = optionalString(args.language);
  const category = optionalString(args.category);
  if (edition && !SOURCE_EDITIONS.includes(edition as never)) throw invalidRequest("edition is invalid.");
  if (language && !SOURCE_LANGUAGES.includes(language as never)) throw invalidRequest("language is invalid.");
  if (category && !SOURCE_CATEGORIES.includes(category as never)) throw invalidRequest("category is invalid.");
  return {
    ...(edition ? { edition: edition as RetrievalSelection["edition"] } : {}),
    ...(language ? { language: language as RetrievalSelection["language"] } : {}),
    ...(category ? { category: category as RetrievalSelection["category"] } : {}),
  };
}

function parsePage(args: ToolArguments): PageInput {
  if (args.limit !== undefined && typeof args.limit !== "number") throw invalidRequest("limit must be a number.");
  return { ...(args.limit !== undefined ? { limit: args.limit } : {}), ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}) };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw invalidRequest(`${name} is required.`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function negotiateHttpVersion(version: string | null): void {
  if (version !== null && version !== AGENT_API_VERSION) {
    throw new AgentGatewayError("unsupported_version", `Unsupported agent API version ${version}.`, 406, { supported: [AGENT_API_VERSION] });
  }
}

function negotiateMcpVersion(version: string | null): void {
  if (version !== null && !MCP_PROTOCOL_VERSIONS.includes(version as never)) {
    throw new AgentGatewayError("unsupported_version", `Unsupported MCP protocol version ${version}.`, 400, { supported: MCP_PROTOCOL_VERSIONS });
  }
}

function decodePathPart(value: string): string {
  try { return decodeURIComponent(value); } catch { throw invalidRequest("Path contains invalid percent encoding."); }
}

function normalizeError(error: unknown): Readonly<Record<string, unknown>> & { code: string; message: string } {
  if (error instanceof AgentGatewayError) return { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) };
  return { code: "internal_error", message: "Internal gateway error." };
}

function errorResponse(error: unknown, requestId: string): Response {
  const normalized = normalizeError(error);
  const status = error instanceof AgentGatewayError ? error.status : 500;
  return json({ error: { ...normalized, requestId } }, status, requestId);
}

function json(body: unknown, status: number, requestId: string): Response {
  return Response.json(body, { status, headers: responseHeaders(requestId) });
}

function responseHeaders(requestId: string): HeadersInit {
  return { "cache-control": "no-store", [AGENT_VERSION_HEADER]: AGENT_API_VERSION, "x-request-id": requestId };
}

function mcpResult(id: unknown, result: unknown, requestId: string): Response {
  return json({ jsonrpc: "2.0", id, result }, 200, requestId);
}

function mcpError(id: unknown, code: number, message: string, machineCode: string, requestId: string,
  details?: Readonly<Record<string, unknown>>): Response {
  return json({ jsonrpc: "2.0", id, error: { code, message, data: { code: machineCode, requestId, ...details } } }, 200, requestId);
}

function canUseTool(principal: AgentPrincipal, tool: AgentToolName): boolean {
  return principal.scopes.has("agent:read") || principal.scopes.has(tool);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toolDefinitions(): readonly Readonly<{ name: AgentToolName; description: string; inputSchema: Record<string, unknown> }>[] {
  const selection = {
    edition: { type: "string", enum: SOURCE_EDITIONS },
    language: { type: "string", enum: SOURCE_LANGUAGES },
    category: { type: "string", enum: SOURCE_CATEGORIES },
  };
  const page = { limit: { type: "integer", minimum: 1, maximum: 200 }, cursor: { type: "string" } };
  const schema = (properties: Record<string, unknown>, required: readonly string[] = []) => ({
    type: "object", additionalProperties: false, properties, ...(required.length ? { required } : {}),
  });
  return [
    { name: "list_entity_types", description: "List accessible indexed entity types.", inputSchema: schema(selection) },
    { name: "list_entries", description: "List accessible canonical entries with cursor pagination.", inputSchema: schema({ ...selection, ...page, entryType: { type: "string" } }) },
    { name: "get_entry", description: "Read an accessible entry by stable UUID or canonical entry ID.", inputSchema: schema({ ...selection, identifier: { type: "string" } }, ["identifier"]) },
    { name: "resolve_alias", description: "Resolve an accessible entry alias.", inputSchema: schema({ ...selection, alias: { type: "string" } }, ["alias"]) },
    { name: "search_entries", description: "Full-text search accessible indexed entries.", inputSchema: schema({ ...selection, ...page, query: { type: "string" }, entryType: { type: "string" } }, ["query"]) },
    { name: "get_source", description: "Read public metadata for an accessible source.", inputSchema: schema({ ...selection, sourceId: { type: "string" } }, ["sourceId"]) },
    { name: "get_citations", description: "Read entry citations and provenance.", inputSchema: schema({ ...selection, identifier: { type: "string" } }, ["identifier"]) },
    { name: "read_section", description: "Read one stable entry section with overlapping citations.", inputSchema: schema({ ...selection, identifier: { type: "string" }, sectionId: { type: "string" } }, ["identifier", "sectionId"]) },
    { name: "list_changed_entries", description: "List accessible current entry changes since a timestamp.", inputSchema: schema({ ...selection, ...page, since: { type: "string", format: "date-time" } }, ["since"]) },
  ];
}
