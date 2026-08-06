import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { AgentProtocol } from "./protocol.ts";
import { FixedWindowRateLimiter } from "./rate-limit.ts";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" };

export type AgentServerOptions = Readonly<{
  host?: string;
  port?: number;
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  maxConcurrent?: number;
  ipRateLimit?: number;
}>;

export function createAgentGatewayServer(protocol = new AgentProtocol(), options: AgentServerOptions = {}) {
  const host = options.host ?? process.env.AGENT_GATEWAY_HOST ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.AGENT_GATEWAY_PORT);
  const maxBodyBytes = options.maxBodyBytes ?? environmentInteger("AGENT_GATEWAY_MAX_BODY_BYTES", 65_536, 1_048_576);
  const maxResponseBytes = options.maxResponseBytes ?? environmentInteger("AGENT_GATEWAY_MAX_RESPONSE_BYTES", 2_097_152, 16_777_216);
  const maxConcurrent = options.maxConcurrent ?? environmentInteger("AGENT_GATEWAY_MAX_CONCURRENT", 32, 1_000);
  const ipLimiter = new FixedWindowRateLimiter(options.ipRateLimit ?? environmentInteger("AGENT_GATEWAY_IP_RATE_LIMIT", 240, 100_000), 60_000);
  let active = 0;

  const handler = async (incoming: IncomingMessage, outgoing: ServerResponse) => {
    const ip = incoming.socket.remoteAddress ?? "unknown";
    if (!ipLimiter.consume(ip)) return sendStatic(outgoing, 429, "rate_limited", "IP request rate exceeded.");
    if (active >= maxConcurrent) return sendStatic(outgoing, 503, "unavailable", "Gateway concurrency limit reached.");
    active++;
    try {
      if (isBodylessMethod(incoming.method) && hasBody(incoming)) {
        incoming.resume();
        return await sendStatic(outgoing, 400, "invalid_request", "GET and health requests must not include a body.");
      }
      if (incoming.headers.expect?.toLowerCase() === "100-continue") {
        const declared = parseContentLength(incoming.headers["content-length"]);
        if (declared !== null && declared > maxBodyBytes) throw new TransportError(413);
        outgoing.writeContinue();
      }
      const request = await toRequest(incoming, host, port, maxBodyBytes);
      await sendResponse(outgoing, await protocol.handle(request), maxResponseBytes);
    } catch (error) {
      const status = error instanceof TransportError ? error.status : 500;
      const code = status === 400 || status === 413 ? "invalid_request" : "internal_error";
      const message = status === 413 ? "Request body is too large." : status === 400 ? "Request framing is invalid." : "Internal gateway error.";
      if (status === 400 || status === 413) {
        incoming.resume();
        outgoing.shouldKeepAlive = false;
      }
      await sendStatic(outgoing, status, code, message);
    } finally {
      active--;
    }
  };

  const server = createServer({ maxHeaderSize: environmentInteger("AGENT_GATEWAY_MAX_HEADER_BYTES", 16_384, 65_536) }, handler);
  server.on("checkContinue", handler);
  server.headersTimeout = environmentInteger("AGENT_GATEWAY_HEADERS_TIMEOUT_MS", 10_000, 120_000);
  server.requestTimeout = environmentInteger("AGENT_GATEWAY_REQUEST_TIMEOUT_MS", 15_000, 120_000);
  server.keepAliveTimeout = environmentInteger("AGENT_GATEWAY_KEEPALIVE_TIMEOUT_MS", 5_000, 60_000);
  server.maxHeadersCount = environmentInteger("AGENT_GATEWAY_MAX_HEADERS", 64, 256);
  server.maxRequestsPerSocket = environmentInteger("AGENT_GATEWAY_MAX_REQUESTS_PER_SOCKET", 100, 1_000);
  return { server, host, port };
}

export function startAgentGateway(protocol = new AgentProtocol(), options: AgentServerOptions = {}) {
  const created = createAgentGatewayServer(protocol, options);
  created.server.listen(created.port, created.host, () => console.log(`Agent gateway listening on http://${created.host}:${created.port}`));
  return created.server;
}

async function toRequest(incoming: IncomingMessage, host: string, port: number, maxBodyBytes: number): Promise<Request> {
  const declared = parseContentLength(incoming.headers["content-length"]);
  if (declared !== null && declared > maxBodyBytes) throw new TransportError(413);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of incoming) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBodyBytes) throw new TransportError(413);
    chunks.push(bytes);
  }
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  const controller = new AbortController();
  incoming.once("aborted", () => controller.abort());
  return new Request(`http://${host}:${port}${incoming.url ?? "/"}`, {
    method: incoming.method ?? "GET",
    headers,
    signal: controller.signal,
    ...(total ? { body: Buffer.concat(chunks) } : {}),
  });
}

async function sendResponse(outgoing: ServerResponse, response: Response, maxBytes: number): Promise<void> {
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > maxBytes) return sendStatic(outgoing, 500, "internal_error", "Gateway response exceeded its configured limit.");
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.setHeader("content-length", bytes.length);
  outgoing.end(bytes);
}

function sendStatic(outgoing: ServerResponse, status: number, code: string, message: string): void {
  if (outgoing.headersSent || outgoing.destroyed) return;
  const bytes = Buffer.from(JSON.stringify({ error: { code, message } }));
  outgoing.writeHead(status, { ...JSON_HEADERS, "content-length": bytes.length });
  outgoing.end(bytes);
}

function isBodylessMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD";
}

function hasBody(incoming: IncomingMessage): boolean {
  return incoming.headers["transfer-encoding"] !== undefined || (parseContentLength(incoming.headers["content-length"]) ?? 0) > 0;
}

function parseContentLength(value: string | undefined): number | null {
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) throw new TransportError(400);
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new TransportError(400);
  return length;
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_GATEWAY_PORT must be an integer from 1 to 65535.");
  return port;
}

function environmentInteger(name: string, fallback: number, maximum: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  return value;
}

class TransportError extends Error {
  readonly status: number;
  constructor(status: number) {
    super("Transport request rejected.");
    this.status = status;
  }
}
