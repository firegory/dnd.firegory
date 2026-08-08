export class OriginValidationError extends Error {
  constructor(message = "A same-origin Origin header is required.") {
    super(message);
    this.name = "OriginValidationError";
  }
}

export function assertSameOriginMutation(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) throw new OriginValidationError();
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new OriginValidationError("Origin header is invalid.");
  }
  const requestUrl = new URL(request.url);
  const host = request.headers.get("host");
  const forwardedProtocol = request.headers.get("x-forwarded-proto");
  if (forwardedProtocol?.includes(",")) throw new OriginValidationError("Forwarded protocol header is invalid.");
  const protocol = forwardedProtocol ? `${forwardedProtocol.trim().toLowerCase()}:` : requestUrl.protocol;
  if (protocol !== "http:" && protocol !== "https:") throw new OriginValidationError("Request protocol is invalid.");
  let expectedOrigin = requestUrl.origin;
  if (host) {
    try {
      expectedOrigin = new URL(`${protocol}//${host}`).origin;
    } catch {
      throw new OriginValidationError("Request host is invalid.");
    }
  }
  if (parsed.origin !== expectedOrigin || origin !== parsed.origin) {
    throw new OriginValidationError("Cross-origin mutation is not allowed.");
  }
}
