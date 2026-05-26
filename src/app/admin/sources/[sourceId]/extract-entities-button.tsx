"use client";

import { useState } from "react";
import { useUiLanguage, type TranslationKey } from "../../../../components/ui/i18n";

export function ExtractEntitiesButton({ sourceId }: { sourceId: string }) {
  const { t } = useUiLanguage();
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleExtract() {
    setStatus("loading");
    setMessage(null);

    try {
      const response = await fetch(
        `/api/admin/ingestion/sources/${sourceId}/extract-entities`,
        { method: "POST" },
      );
      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setMessage(data.error ?? t("extractEntitiesFailed"));
        return;
      }

      setStatus("success");
      setMessage(t("extractEntitiesStarted"));
    } catch (err) {
      setStatus("error");
      setMessage(err instanceof Error ? err.message : t("networkError"));
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{t("extractEntities")}</h2>
          <p className="mt-1 text-sm text-text-muted">
            {t("extractEntitiesDescription" as TranslationKey)}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {message && (
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${
                status === "error"
                  ? "bg-danger/15 text-danger"
                  : "bg-success/15 text-success"
              }`}
            >
              {message}
            </span>
          )}
          <button
            type="button"
            onClick={() => void handleExtract()}
            disabled={status === "loading"}
            className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          >
            {status === "loading"
              ? t("extractingEntities")
              : t("extractEntities")}
          </button>
        </div>
      </div>
    </section>
  );
}
