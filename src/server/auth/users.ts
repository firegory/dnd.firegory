import { withTransaction, query } from "../db/client";
import { hashPassword, verifyPassword } from "./password";
import { isUserRole, type AuthUser, type UserRole } from "./types";

export type PublicUser = AuthUser &
  Readonly<{
    createdAt: Date;
    lastLoginAt: Date | null;
    disabledAt: Date | null;
  }>;

type UserRow = Readonly<{
  id: string;
  email: string;
  role: UserRole;
  display_name: string | null;
  created_at: Date;
  last_login_at: Date | null;
  disabled_at: Date | null;
}>;

type AuthRow = UserRow & Readonly<{ password_hash: string }>;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function registerUser(input: {
  email: string;
  password: string;
  displayName?: string;
}): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  if (!email.includes("@")) {
    throw new Error("A valid email address is required.");
  }

  const passwordHash = await hashPassword(input.password);
  const displayName = input.displayName?.trim() || null;

  return withTransaction(async (client) => {
    await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
    const existingUsers = await client.query<{ count: string }>("SELECT count(*) FROM users");
    const role: UserRole = existingUsers.rows[0]?.count === "0" ? "admin" : "user";

    const result = await client.query<UserRow>(
      `INSERT INTO users (email, password_hash, display_name, role)
       VALUES ($1, $2, $3, $4)
       RETURNING id, email, role, display_name, created_at, last_login_at, disabled_at`,
      [email, passwordHash, displayName, role],
    );

    const row = result.rows[0];
    return toAuthUser(row);
  });
}

export async function authenticateUser(emailInput: string, password: string): Promise<AuthUser | null> {
  const email = normalizeEmail(emailInput);
  const result = await query<AuthRow>(
    `SELECT id, email, password_hash, role, display_name, created_at, last_login_at, disabled_at
     FROM users
     WHERE email = $1 AND disabled_at IS NULL
     LIMIT 1`,
    [email],
  );

  const row = result.rows[0];
  if (!row) return null;

  const matches = await verifyPassword(password, row.password_hash);
  if (!matches) return null;

  await query("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
  return toAuthUser(row);
}

export async function listUsers(): Promise<readonly PublicUser[]> {
  const result = await query<UserRow>(
    `SELECT id, email, role, display_name, created_at, last_login_at, disabled_at
     FROM users
     WHERE disabled_at IS NULL
     ORDER BY created_at ASC, email ASC`,
  );
  return result.rows.map(toPublicUser);
}

export async function updateUserRole(userId: string, role: string): Promise<AuthUser> {
  if (!isUserRole(role)) {
    throw new Error("Invalid user role.");
  }

  return withTransaction(async (client) => {
    await client.query("LOCK TABLE users IN EXCLUSIVE MODE");

    const current = await client.query<UserRow>(
      `SELECT id, email, role, display_name, created_at, last_login_at, disabled_at
       FROM users
       WHERE id = $1 AND disabled_at IS NULL
       LIMIT 1`,
      [userId],
    );
    const currentUser = current.rows[0];
    if (!currentUser) {
      throw new Error("User not found.");
    }

    if (currentUser.role === "admin" && role !== "admin") {
      const adminCount = await client.query<{ count: string }>(
        "SELECT count(*) FROM users WHERE role = 'admin' AND disabled_at IS NULL",
      );
      if (adminCount.rows[0]?.count === "1") {
        throw new Error("Cannot remove the last active admin.");
      }
    }

    const result = await client.query<UserRow>(
      `UPDATE users
       SET role = $2, updated_at = now()
       WHERE id = $1 AND disabled_at IS NULL
       RETURNING id, email, role, display_name, created_at, last_login_at, disabled_at`,
      [userId, role],
    );

    return toAuthUser(result.rows[0]);
  });
}

function toAuthUser(row: Pick<UserRow, "id" | "email" | "role" | "display_name">): AuthUser {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
  };
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    ...toAuthUser(row),
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    disabledAt: row.disabled_at,
  };
}
