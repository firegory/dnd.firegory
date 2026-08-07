const port = process.env.PORT ?? "3000";
const response = await fetch(`http://127.0.0.1:${port}/api/healthz`, {
  signal: AbortSignal.timeout(5_000),
});
if (!response.ok) process.exit(1);
