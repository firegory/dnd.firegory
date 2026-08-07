import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";

import { query } from "../db/client";
import { createSessionToken, hashSessionToken, sessionExpiresAt } from "./session-token";
import type { AuthUser, SessionUser } from "./types";
import { validatedRedirectPath } from "../http/redirect-path";

export const SESSION_COOKIE_NAME = "dnd_firegory_session";

type SessionUserRow = Readonly<{
  session_id: string;
  expires_at: Date;
  user_id: string;
  email: string;
  role: AuthUser["role"];
  display_name: string | null;
}>;

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const expiresAt = sessionExpiresAt();

  await query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, hashSessionToken(token), expiresAt],
  );

  return { token, expiresAt };
}

export async function findSessionUserByToken(token: string): Promise<SessionUser | null> {
  const result = await query<SessionUserRow>(
    `SELECT
       sessions.id AS session_id,
       sessions.expires_at,
       users.id AS user_id,
       users.email,
       users.role,
       users.display_name
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1
       AND sessions.revoked_at IS NULL
       AND sessions.expires_at > now()
       AND users.disabled_at IS NULL
     LIMIT 1`,
    [hashSessionToken(token)],
  );

  const row = result.rows[0];
  if (!row) return null;

  await query("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.session_id]);

  return {
    id: row.user_id,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
    sessionId: row.session_id,
    sessionExpiresAt: row.expires_at,
  };
}

export async function getCurrentUser(): Promise<SessionUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  return findSessionUserByToken(token);
}

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) {
    const nextPath = validatedRedirectPath((await headers()).get("x-dnd-request-path"));
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }
  return user;
}

export async function requireAdmin(): Promise<SessionUser & { role: "admin" }> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/");
  return user as SessionUser & { role: "admin" };
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(SESSION_COOKIE_NAME);
}

export async function revokeSession(token: string): Promise<void> {
  await query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1", [
    hashSessionToken(token),
  ]);
}

export async function getSessionTokenFromCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}
