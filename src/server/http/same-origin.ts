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
  if (parsed.origin !== requestUrl.origin || origin !== parsed.origin) {
    throw new OriginValidationError("Cross-origin mutation is not allowed.");
  }
}
