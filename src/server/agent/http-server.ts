import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { AgentProtocol } from "./protocol.ts";

export function startAgentGateway(
  protocol = new AgentProtocol(),
  options: Readonly<{ host?: string; port?: number }> = {},
) {
  const host = options.host ?? process.env.AGENT_GATEWAY_HOST ?? "127.0.0.1";
  const port = options.port ?? parsePort(process.env.AGENT_GATEWAY_PORT);
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await toRequest(incoming, host, port);
      await sendResponse(outgoing, await protocol.handle(request));
    } catch {
      await sendResponse(outgoing, Response.json({ error: { code: "internal_error", message: "Internal gateway error." } }, { status: 500 }));
    }
  });
  server.listen(port, host, () => console.log(`Agent gateway listening on http://${host}:${port}`));
  return server;
}

async function toRequest(incoming: IncomingMessage, host: string, port: number): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else if (value !== undefined) headers.set(name, value);
  }
  return new Request(`http://${headers.get("host") ?? `${host}:${port}`}${incoming.url ?? "/"}`, {
    method: incoming.method ?? "GET", headers, ...(body ? { body } : {}),
  });
}

async function sendResponse(outgoing: ServerResponse, response: Response): Promise<void> {
  outgoing.statusCode = response.status;
  response.headers.forEach((value, name) => outgoing.setHeader(name, value));
  outgoing.end(Buffer.from(await response.arrayBuffer()));
}

function parsePort(value: string | undefined): number {
  const port = value === undefined ? 8787 : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("AGENT_GATEWAY_PORT must be an integer from 1 to 65535.");
  return port;
}
