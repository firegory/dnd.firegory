import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";

import { CursorCodec } from "../../src/server/agent/cursor.ts";
import { createAgentGatewayServer } from "../../src/server/agent/http-server.ts";
import type { AgentProtocol } from "../../src/server/agent/protocol.ts";

const secret = "security-test-cursor-secret-at-least-32-bytes";

test("cursors are bounded, authenticated, filter-bound, and strictly typed", () => {
  const codec = new CursorCodec(secret);
  const binding = { kind: "entries", role: "user", edition: "5e" };
  const token = codec.encode("entries", binding, { key: "dash", id: "10000000-0000-4000-8000-000000000001" });
  assert.deepEqual(codec.decode("entries", binding, token), { key: "dash", id: "10000000-0000-4000-8000-000000000001" });
  assert.throws(() => codec.decode("entries", { ...binding, edition: "5.5e" }, token), /cursor is invalid/);
  assert.throws(() => codec.decode("entries", binding, `${token.slice(0, -1)}x`), /cursor is invalid/);
  assert.throws(() => codec.decode("entries", binding, "x".repeat(1025)), /cursor is invalid/);

  const payload = Buffer.from(JSON.stringify({
    v: 1, kind: "search",
    binding: createHmac("sha256", "dnd-firegory-agent-cursor-binding-v1").update(JSON.stringify(binding)).digest("base64url"),
    data: { key: "dash", id: "not-a-uuid", rank: Number.NaN },
  })).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  assert.throws(() => codec.decode("search", binding, `${payload}.${signature}`), /cursor is invalid/);
  assert.throws(() => codec.decode("changes", binding, signedCursor("changes", binding, {
    key: " dash ", id: "10000000-0000-4000-8000-000000000001", changedAt: "not-a-timestamp",
  })), /cursor is invalid/);
});

test("gateway database and container defaults are bounded and non-root", async () => {
  const database = await readFile(new URL("../../src/server/agent/database.ts", import.meta.url), "utf8");
  assert.match(database, /statement_timeout:/);
  assert.match(database, /query_timeout:/);
  assert.match(database, /max: positiveInteger/);
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  const gatewayStart = dockerfile.indexOf("FROM ${NODE_IMAGE} AS agent-gateway");
  const gatewayEnd = dockerfile.indexOf("FROM ${NODE_IMAGE} AS production-dependencies");
  assert.notEqual(gatewayStart, -1);
  assert.ok(gatewayEnd > gatewayStart);
  const gatewayStage = dockerfile.slice(gatewayStart, gatewayEnd);
  assert.match(dockerfile, /^ARG NODE_IMAGE=node:\d+\.\d+\.\d+-bookworm-slim$/m);
  assert.match(gatewayStage, /COPY --from=agent-dependencies \/app\/node_modules \.\/node_modules/);
  assert.match(gatewayStage, /USER 10001:10001/);
  assert.match(gatewayStage, /AGENT_GATEWAY_HOST=127\.0\.0\.1/);
});

test("transport rejects GET bodies before protocol dispatch and caps streaming request bodies", async () => {
  let calls = 0;
  const protocol = { handle: async () => { calls++; return Response.json({ ok: true }); } } as AgentProtocol;
  await withServer(protocol, { maxBodyBytes: 32 }, async (port) => {
    const get = await rawRequest(port, "GET", "/healthz", "body");
    assert.equal(get.status, 400);
    assert.equal(calls, 0);
    const large = await rawRequest(port, "POST", "/mcp", "x".repeat(33), { "content-type": "application/json" });
    assert.equal(large.status, 413);
    assert.equal(calls, 0);
  });
});

test("transport sets timeouts and enforces IP, concurrency, and response limits", async () => {
  let release: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const protocol = { handle: async (request: Request) => {
    calls++;
    if (new URL(request.url).pathname === "/block") await blocked;
    if (new URL(request.url).pathname === "/large") return Response.json({ value: "x".repeat(200) });
    return Response.json({ ok: true });
  } } as AgentProtocol;
  const created = createAgentGatewayServer(protocol, { host: "127.0.0.1", maxConcurrent: 1, ipRateLimit: 3, maxResponseBytes: 64 });
  assert.equal(created.server.headersTimeout, 10_000);
  assert.equal(created.server.requestTimeout, 15_000);
  assert.equal(created.server.keepAliveTimeout, 5_000);
  await listen(created.server);
  const port = addressPort(created.server);
  const first = rawRequest(port, "GET", "/block");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await rawRequest(port, "GET", "/other")).status, 503);
  release?.();
  assert.equal((await first).status, 200);
  assert.equal((await rawRequest(port, "GET", "/large")).status, 500);
  assert.equal((await rawRequest(port, "GET", "/other")).status, 429);
  assert.equal(calls, 2);
  await close(created.server);
});

async function withServer(protocol: AgentProtocol, options: Parameters<typeof createAgentGatewayServer>[1], callback: (port: number) => Promise<void>): Promise<void> {
  const created = createAgentGatewayServer(protocol, { host: "127.0.0.1", ...options });
  await listen(created.server);
  try { await callback(addressPort(created.server)); } finally { await close(created.server); }
}

function listen(server: ReturnType<typeof createAgentGatewayServer>["server"]): Promise<void> {
  return new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
}

function close(server: ReturnType<typeof createAgentGatewayServer>["server"]): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function addressPort(server: ReturnType<typeof createAgentGatewayServer>["server"]): number {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Server did not bind TCP.");
  return address.port;
}

function rawRequest(port: number, method: string, path: string, body = "", headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

function signedCursor(kind: string, binding: Record<string, unknown>, data: Record<string, unknown>): string {
  const bindingHash = createHmac("sha256", "dnd-firegory-agent-cursor-binding-v1").update(JSON.stringify(binding)).digest("base64url");
  const payload = Buffer.from(JSON.stringify({ v: 1, kind, binding: bindingHash, data })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
