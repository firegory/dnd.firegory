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

export async function resolveAdminContextFromRequest(request?: Request): Promise<AdminContext | null> {
  void request;
  try {
    const { requireAdmin } = await import("../auth/session");
    const user = await requireAdmin();
    return { userId: user.id, role: "admin" };
  } catch {
    return null;
  }
}
