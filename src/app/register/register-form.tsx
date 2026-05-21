"use client";

import { useActionState } from "react";

import { useUiLanguage } from "../../components/ui/i18n";
import { registerAction } from "../../server/auth/actions";

export function RegisterForm() {
  const { t } = useUiLanguage();
  const [state, action, pending] = useActionState(registerAction, {});

  return (
    <form action={action} className="auth-form">
      <label>
        {t("email")}
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label>
        {t("displayName")}
        <input name="displayName" type="text" autoComplete="name" />
      </label>
      <label>
        {t("password")}
        <input
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={12}
          required
        />
      </label>
      <p className="hint">{t("passwordHint")}</p>
      {state.error ? <p className="form-error">{state.error}</p> : null}
      <button type="submit" disabled={pending}>
        {pending ? t("creatingAccount") : t("createAccount")}
      </button>
    </form>
  );
}
