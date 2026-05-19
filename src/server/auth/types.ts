export const USER_ROLES = ["user", "premium", "admin"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export type AuthUser = Readonly<{
  id: string;
  email: string;
  role: UserRole;
  displayName: string | null;
}>;

export type SessionUser = AuthUser &
  Readonly<{
    sessionId: string;
    sessionExpiresAt: Date;
  }>;

export function isUserRole(value: string): value is UserRole {
  return USER_ROLES.includes(value as UserRole);
}

export function assertAdmin(user: AuthUser | null | undefined): asserts user is AuthUser & { role: "admin" } {
  if (user?.role !== "admin") {
    throw new Error("Admin role is required.");
  }
}

export function canManageRoles(user: AuthUser | null | undefined): boolean {
  return user?.role === "admin";
}
