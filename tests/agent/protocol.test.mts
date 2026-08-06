import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { AgentAuthenticator, AGENT_TOOLS, parseTokenPolicies } from "../../src/server/agent/auth.ts";
import { AgentProtocol, AGENT_VERSION_HEADER, MCP_PROTOCOL_VERSIONS } from "../../src/server/agent/protocol.ts";
import { FixedWindowRateLimiter } from "../../src/server/agent/rate-limit.ts";

const secret = "test-agent-secret";
const tokenPolicies = JSON.stringify([{
  id: "test-agent",
  sha256: createHash("sha256").update(secret).digest("hex"),
  role: "premium",
  userId: "owner-user",
  scopes: ["agent:read"],
}]);

test("every HTTP v1 operation dispatches through the shared read service", async () => {
  const service = fakeService();
  const protocol = new AgentProtocol(service, authenticator());
  const cases = [
    ["/v1/entity-types?edition=5e", "list_entity_types"],
    ["/v1/entries?limit=2&entryType=action", "list_entries"],
    ["/v1/entries/dash", "get_entry"],
    ["/v1/aliases/Dash%20action", "resolve_alias"],
    ["/v1/search?query=dash&limit=2", "search_entries"],
    ["/v1/sources/10000000-0000-4000-8000-000000000001", "get_source"],
    ["/v1/entries/dash/citations", "get_citations"],
    ["/v1/entries/dash/sections/dash-rule", "read_section"],
    ["/v1/changes?since=2026-01-01T00%3A00%3A00Z", "list_changed_entries"],
  ] as const;

  for (const [path, method] of cases) {
    const response = await protocol.handle(request(path));
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get(AGENT_VERSION_HEADER), "1");
    const body = await response.json() as { data: { operation: string }; meta: { version: string } };
    assert.equal(body.data.operation, method);
    assert.equal(body.meta.version, "1");
  }
  assert.deepEqual(service.calls.map((call) => call.name), cases.map((entry) => entry[1]));
  assert.deepEqual(service.calls[0].args[0], { role: "premium", userId: "owner-user" });
});

test("MCP negotiates versions, lists scoped tools, and calls every named tool", async () => {
  const service = fakeService();
  const protocol = new AgentProtocol(service, authenticator());
  const initialized = await protocol.handle(mcp({
    jsonrpc: "2.0", id: 1, method: "initialize", params: {
      protocolVersion: MCP_PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: { name: "test", version: "1" },
    },
  }));
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json() as { result: { protocolVersion: string } }).result.protocolVersion, MCP_PROTOCOL_VERSIONS[0]);

  const listed = await protocol.handle(mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const tools = (await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.deepEqual(tools.map((tool) => tool.name), AGENT_TOOLS);

  const argumentsByTool: Record<string, Record<string, unknown>> = {
    list_entity_types: {}, list_entries: {}, get_entry: { identifier: "dash" },
    resolve_alias: { alias: "Dash action" }, search_entries: { query: "dash" },
    get_source: { sourceId: "source" }, get_citations: { identifier: "dash" },
    read_section: { identifier: "dash", sectionId: "dash-rule" },
    list_changed_entries: { since: "2026-01-01T00:00:00Z" },
  };
  for (const [index, name] of AGENT_TOOLS.entries()) {
    const response = await protocol.handle(mcp({
      jsonrpc: "2.0", id: index + 10, method: "tools/call", params: { name, arguments: argumentsByTool[name] },
    }));
    const result = (await response.json() as { result: { isError: boolean; structuredContent: { operation: string } } }).result;
    assert.equal(result.isError, false, name);
    assert.equal(result.structuredContent.operation, name);
  }
});

test("HTTP and MCP return stable machine-readable authentication, scope, input, and version errors", async () => {
  const service = fakeService();
  const protocol = new AgentProtocol(service, authenticator());

  const unauthorized = await protocol.handle(new Request("http://gateway/v1/entries"));
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json() as { error: { code: string; requestId: string } }).error.code, "authentication_required");

  const unsupported = await protocol.handle(request("/v1/entries", { [AGENT_VERSION_HEADER]: "2" }));
  assert.equal(unsupported.status, 406);
  const unsupportedBody = await unsupported.json() as { error: { code: string; details: { supported: string[] } } };
  assert.equal(unsupportedBody.error.code, "unsupported_version");
  assert.deepEqual(unsupportedBody.error.details.supported, ["1"]);

  const badMcpVersion = await protocol.handle(mcp({
    jsonrpc: "2.0", id: 3, method: "initialize", params: {
      protocolVersion: "1900-01-01", capabilities: {}, clientInfo: { name: "test", version: "1" },
    },
  }));
  const mcpVersionError = await badMcpVersion.json() as { error: { data: { code: string } } };
  assert.equal(mcpVersionError.error.data.code, "unsupported_version");

  const scoped = new AgentAuthenticator(parseTokenPolicies(JSON.stringify([{
    id: "list-only", sha256: createHash("sha256").update("scoped").digest("hex"), role: "user", scopes: ["list_entries"],
  }])));
  const scopedProtocol = new AgentProtocol(service, scoped);
  const forbidden = await scopedProtocol.handle(request("/v1/entries/dash", {}, "scoped"));
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error: { code: string } }).error.code, "forbidden");

  const badInput = await protocol.handle(request("/v1/search"));
  assert.equal(badInput.status, 400);
  assert.equal((await badInput.json() as { error: { code: string } }).error.code, "invalid_request");
});

test("healthcheck is unauthenticated and reports database degradation", async () => {
  const healthy = new AgentProtocol(fakeService(), authenticator());
  assert.deepEqual(await (await healthy.handle(new Request("http://gateway/healthz"))).json(), { status: "ok", version: "1" });

  const failed = fakeService();
  failed.health = async () => { throw new Error("database unavailable"); };
  const response = await new AgentProtocol(failed, authenticator()).handle(new Request("http://gateway/healthz"));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { status: "unavailable", version: "1" });
});

test("healthcheck caches and coalesces database probes", async () => {
  const service = fakeService();
  let probes = 0;
  service.health = async () => { probes++; };
  let now = 1_000;
  const protocol = new AgentProtocol(service, authenticator(), { healthCacheMs: 100, now: () => now });
  await Promise.all([
    protocol.handle(new Request("http://gateway/healthz")),
    protocol.handle(new Request("http://gateway/healthz")),
  ]);
  await protocol.handle(new Request("http://gateway/healthz"));
  assert.equal(probes, 1);
  now += 101;
  await protocol.handle(new Request("http://gateway/healthz"));
  assert.equal(probes, 2);
});

test("MCP rejects malformed envelopes, versions, content types, nulls, batches, and unknown arguments", async () => {
  const protocol = new AgentProtocol(fakeService(), authenticator());
  const cases: Array<{ request: Request; rpcCode?: number; status?: number }> = [
    { request: mcp(null), rpcCode: -32600 },
    { request: mcp([]), rpcCode: -32600 },
    { request: mcp({ jsonrpc: "2.0", id: null, method: "tools/list" }), rpcCode: -32600 },
    { request: mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", params: null }), rpcCode: -32602 },
    { request: mcp({ jsonrpc: "2.0", id: 1, method: "tools/list", extra: true }), rpcCode: -32600 },
    { request: mcp({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_entry", arguments: { identifier: "dash", surprise: true } } }), rpcCode: -32602 },
    { request: mcp({ jsonrpc: "2.0", id: 1, method: "unknown" }), rpcCode: -32601 },
    { request: new Request("http://gateway/mcp", { method: "POST", headers: { authorization: `Bearer ${secret}`, "content-type": "text/plain" }, body: "{}" }), status: 415 },
  ];
  for (const testCase of cases) {
    const response = await protocol.handle(testCase.request);
    if (testCase.status) assert.equal(response.status, testCase.status);
    else assert.equal((await response.json() as { error: { code: number } }).error.code, testCase.rpcCode);
  }

  const missingVersion = await protocol.handle(mcp(
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    { "mcp-protocol-version": "" },
  ));
  assert.equal((await missingVersion.json() as { error: { data: { code: string } } }).error.data.code, "unsupported_version");

  const notification = await protocol.handle(mcp({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }));
  assert.equal(notification.status, 202);
  assert.equal(await notification.text(), "");

  const malformed = await protocol.handle(new Request("http://gateway/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: "{",
  }));
  assert.equal((await malformed.json() as { error: { code: number } }).error.code, -32700);

  const duplicateQuery = await protocol.handle(request("/v1/entries?limit=1&limit=2"));
  assert.equal(duplicateQuery.status, 400);
});

test("session bearer policy resolves RBAC identity without writing session state", async () => {
  const sql: string[] = [];
  const auth = new AgentAuthenticator([], true, {
    async query(statement: string) {
      sql.push(statement);
      return { rows: [{ user_id: "session-user", role: "premium" }] } as never;
    },
  });
  const principal = await auth.authenticate("Bearer existing-session-token");
  assert.deepEqual(principal.user, { role: "premium", userId: "session-user" });
  assert.equal(principal.authentication, "session");
  assert.equal(sql.length, 1);
  assert.match(sql[0], /^SELECT/);
  assert.doesNotMatch(sql[0], /UPDATE|INSERT|DELETE/);
});

test("authenticated principals have an independent request rate limit", async () => {
  const protocol = new AgentProtocol(fakeService(), authenticator(), {
    principalLimiter: new FixedWindowRateLimiter(1, 60_000),
  });
  assert.equal((await protocol.handle(request("/v1/entries"))).status, 200);
  const limited = await protocol.handle(request("/v1/entries"));
  assert.equal(limited.status, 429);
  assert.equal((await limited.json() as { error: { code: string } }).error.code, "rate_limited");
});

function authenticator(): AgentAuthenticator {
  return new AgentAuthenticator(parseTokenPolicies(tokenPolicies));
}

function request(path: string, extraHeaders: HeadersInit = {}, token = secret): Request {
  return new Request(`http://gateway${path}`, { headers: { authorization: `Bearer ${token}`, ...extraHeaders } });
}

function mcp(body: unknown, extraHeaders: HeadersInit = {}): Request {
  return new Request("http://gateway/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", "mcp-protocol-version": MCP_PROTOCOL_VERSIONS[0], ...extraHeaders },
    body: JSON.stringify(body),
  });
}

function fakeService() {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const operation = (name: string) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return { operation: name, citations: name === "get_citations" ? [{ citationId: "citation" }] : [] };
  };
  return {
    calls,
    health: async () => {},
    listEntityTypes: operation("list_entity_types"),
    listEntries: operation("list_entries"),
    getEntry: operation("get_entry"),
    resolveAlias: operation("resolve_alias"),
    searchEntries: operation("search_entries"),
    getSource: operation("get_source"),
    getCitations: operation("get_citations"),
    readSection: operation("read_section"),
    listChangedEntries: operation("list_changed_entries"),
  };
}
