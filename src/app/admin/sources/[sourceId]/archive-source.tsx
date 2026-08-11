"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { useUiLanguage } from "../../../../components/ui/i18n";

export function ArchiveSource({ sourceId, title }: { sourceId: string; title: string }) {
  const router = useRouter();
  const { t } = useUiLanguage();
  const [confirmationTitle, setConfirmationTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "archiving" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  async function archive() {
    setStatus("archiving");
    setError(null);
    try {
      const response = await fetch(`/api/admin/sources/${sourceId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmationTitle }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus("error");
        setError(data.error ?? t("archiveSourceFailed"));
        return;
      }
      router.replace("/admin/sources");
      router.refresh();
    } catch (caught) {
      setStatus("error");
      setError(caught instanceof Error ? caught.message : t("networkError"));
    }
  }

  return (
    <section className="rounded-xl border border-danger/40 bg-danger/5 p-5" aria-labelledby="archive-source-title">
      <h2 id="archive-source-title" className="text-lg font-bold text-danger">{t("dangerZone")}</h2>
      <h3 className="mt-3 font-semibold text-text-primary">{t("archiveSource")}</h3>
      <p className="mt-1 text-sm text-text-secondary">{t("archiveSourceDescription")}</p>
      <label className="mt-4 flex max-w-xl flex-col gap-1.5">
        <span className="text-sm text-text-secondary">{t("archiveSourceConfirmation", { title })}</span>
        <input
          value={confirmationTitle}
          onChange={(event) => setConfirmationTitle(event.target.value)}
          disabled={status === "archiving"}
          autoComplete="off"
          className="rounded-lg border border-danger/40 bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-danger focus:ring-2 focus:ring-danger/20 disabled:opacity-60"
        />
      </label>
      {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}
      <button
        type="button"
        onClick={() => void archive()}
        disabled={confirmationTitle !== title || status === "archiving"}
        className="mt-4 rounded-xl bg-danger px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {status === "archiving" ? t("archivingSource") : t("archiveSource")}
      </button>
    </section>
  );
}
