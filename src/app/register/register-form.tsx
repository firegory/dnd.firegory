"use client";

import { useActionState } from "react";

import { useUiLanguage } from "../../components/ui/i18n";
import { registerAction } from "../../server/auth/actions";

export function RegisterForm() {
  const { t } = useUiLanguage();
  const [state, action, pending] = useActionState(registerAction, {});

  return (
    <form action={action} className="space-y-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reg-email" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("email")}</label>
        <input id="reg-email" name="email" type="email" autoComplete="email" required className="rounded-xl border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reg-display-name" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("displayName")}</label>
        <input id="reg-display-name" name="displayName" type="text" autoComplete="name" className="rounded-xl border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="reg-password" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("password")}</label>
        <input id="reg-password" name="password" type="password" autoComplete="new-password" minLength={12} required className="rounded-xl border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20" />
      </div>
      <p className="text-xs text-text-muted">{t("passwordHint")}</p>
      {state.error ? <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
        {pending ? t("creatingAccount") : t("createAccount")}
      </button>
    </form>
  );
}
