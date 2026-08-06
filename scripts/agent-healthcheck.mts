const port = process.env.AGENT_GATEWAY_PORT ?? "8787";
const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
if (!response.ok) process.exit(1);
