export type AdminContext = Readonly<{
  userId: string;
  role: "admin";
}>;

export class AdminRequiredError extends Error {
  constructor(message = "Admin privileges are required.") {
    super(message);
    this.name = "AdminRequiredError";
  }
}

export function assertAdminContext(
  context: AdminContext | null | undefined,
): asserts context is AdminContext {
  if (!context || context.role !== "admin" || context.userId.trim() === "") {
    throw new AdminRequiredError();
  }
}

/**
 * Temporary server-side auth adapter for issue #5.
 *
 * The real request/session lookup belongs to the auth foundation tracked in
 * issue #4. Until that lands, API routes deliberately deny access instead of
 * trusting client-controlled headers or query params. Unit tests and internal
 * callers can inject an AdminContext directly into the content metadata
 * service, so the CRUD model is usable without implementing auth here.
 */
export async function resolveAdminContextFromRequest(request?: Request): Promise<AdminContext | null> {
  void request;
  return null;
}
