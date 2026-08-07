"use client";

import { useActionState } from "react";

import { useUiLanguage } from "../../components/ui/i18n";
import { loginAction } from "../../server/auth/actions";

export function LoginForm({ nextPath }: { nextPath: string }) {
  const { t } = useUiLanguage();
  const [state, action, pending] = useActionState(loginAction, {});

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="next" value={nextPath} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-email" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("email")}</label>
        <input id="login-email" name="email" type="email" autoComplete="email" required className="rounded-xl border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20" />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="login-password" className="text-xs font-semibold uppercase tracking-wide text-text-muted">{t("password")}</label>
        <input id="login-password" name="password" type="password" autoComplete="current-password" required className="rounded-xl border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-accent focus:ring-2 focus:ring-accent/20" />
      </div>
      {state.error ? <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">{state.error}</p> : null}
      <button type="submit" disabled={pending} className="w-full rounded-xl bg-accent px-4 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60">
        {pending ? t("signingIn") : t("signIn")}
      </button>
    </form>
  );
}
