"use client";

import { useActionState } from "react";

import { useUiLanguage } from "../../components/ui/i18n";
import { loginAction } from "../../server/auth/actions";

export function LoginForm() {
  const { t } = useUiLanguage();
  const [state, action, pending] = useActionState(loginAction, {});

  return (
    <form action={action} className="auth-form">
      <label>
        {t("email")}
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        {t("password")}
        <input name="password" type="password" autoComplete="current-password" required />
      </label>
      {state.error ? <p className="form-error">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
