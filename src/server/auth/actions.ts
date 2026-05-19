"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { registerUser, authenticateUser, updateUserRole } from "./users";
import {
  clearSessionCookie,
  createSession,
  getSessionTokenFromCookie,
  requireAdmin,
  revokeSession,
  setSessionCookie,
} from "./session";

export type AuthActionState = Readonly<{ error?: string }>;

export async function registerAction(
  _state: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  try {
    const user = await registerUser({
      email: String(formData.get("email") ?? ""),
      password: String(formData.get("password") ?? ""),
      displayName: String(formData.get("displayName") ?? ""),
    });
    const session = await createSession(user.id);
    await setSessionCookie(session.token, session.expiresAt);
  } catch (error) {
    return { error: toMessage(error) };
  }

  redirect("/");
}

export async function loginAction(
  _state: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const user = await authenticateUser(
    String(formData.get("email") ?? ""),
    String(formData.get("password") ?? ""),
  );

  if (!user) {
    return { error: "Invalid email or password." };
  }

  const session = await createSession(user.id);
  await setSessionCookie(session.token, session.expiresAt);
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const token = await getSessionTokenFromCookie();
  if (token) {
    await revokeSession(token);
  }
  await clearSessionCookie();
  redirect("/login");
}

export async function updateUserRoleAction(formData: FormData): Promise<void> {
  await requireAdmin();
  await updateUserRole(
    String(formData.get("userId") ?? ""),
    String(formData.get("role") ?? ""),
  );
  revalidatePath("/admin/users");
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error.";
}
