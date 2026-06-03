"use client";

import { useState, useTransition } from "react";
import { generateLinkTokenAction, unlinkTelegramAction } from "./actions";
import { useUiLanguage } from "../../components/ui/i18n";

export function SettingsClient({ isLinked: initialLinked }: { isLinked: boolean }) {
  const { t } = useUiLanguage();
  const [isLinked, setIsLinked] = useState(initialLinked);
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleLink() {
    setError(null);
    startTransition(async () => {
      try {
        const token = await generateLinkTokenAction();
        setCode(token);
      } catch {
        setError(t("telegramGenerateFailed"));
      }
    });
  }

  function handleUnlink() {
    setError(null);
    startTransition(async () => {
      try {
        await unlinkTelegramAction();
        setIsLinked(false);
        setCode(null);
      } catch {
        setError(t("telegramUnlinkFailed"));
      }
    });
  }

  if (isLinked && !code) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="inline-flex rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
            {t("telegramLinked")}
          </span>
        </div>
        <button
          onClick={handleUnlink}
          disabled={isPending}
          className="inline-flex w-fit items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-light hover:text-text-primary disabled:opacity-50"
        >
          {isPending ? t("telegramUnlinking") : t("telegramUnlink")}
        </button>
      </div>
    );
  }

  if (code) {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-text-secondary">
          {t("telegramSendCode")}
        </p>
        <div className="flex items-center gap-4">
          <div className="rounded-lg border border-border bg-primary/60 px-6 py-3 font-mono text-2xl font-bold tracking-[0.4em] text-text-primary">
            {code}
          </div>
          <button
            onClick={() => setCode(null)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-light hover:text-text-primary"
          >
            {t("telegramCancel")}
          </button>
        </div>
        <p className="text-xs text-text-muted">
          {t("telegramCodeExpires")}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-secondary">
        {t("telegramLinkDescription")}
      </p>
      <button
        onClick={handleLink}
        disabled={isPending}
        className="inline-flex w-fit items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-primary shadow-lg shadow-accent/20 transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {isPending ? t("telegramGenerating") : t("telegramLinkButton")}
      </button>
      {error && (
        <p className="text-sm text-danger">{error}</p>
      )}
    </div>
  );
}
