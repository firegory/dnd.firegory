"use client";

import { useActionState } from "react";

import { registerAction } from "../../server/auth/actions";

export function RegisterForm() {
  const [state, action, pending] = useActionState(registerAction, {});

  return (
    <form action={action} className="auth-form">
      <label>
        Email
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        Display name
        <input name="displayName" type="text" autoComplete="name" />
      </label>
      <label>
        Password
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <p className="hint">Use at least 12 characters. The first registered user becomes admin.</p>
      {state.error ? <p className="form-error">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? "Creating account…" : "Create account"}
      </button>
    </form>
  );
}
