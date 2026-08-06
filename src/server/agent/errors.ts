export type AgentErrorCode =
  | "authentication_required"
  | "forbidden"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "unsupported_version"
  | "internal_error";

export class AgentGatewayError extends Error {
  readonly code: AgentErrorCode;
  readonly status: number;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: AgentErrorCode,
    message: string,
    status: number,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "AgentGatewayError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function invalidRequest(message: string): AgentGatewayError {
  return new AgentGatewayError("invalid_request", message, 400);
}

export function notFound(message = "The requested resource was not found."): AgentGatewayError {
  return new AgentGatewayError("not_found", message, 404);
}
