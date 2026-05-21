"use client";

import { useEffect, useState } from "react";
import { AppSelect } from "../../../../components/ui/select";
import { useUiLanguage } from "../../../../components/ui/i18n";
import type { SourceWithStats } from "../../../../server/admin/source-view";

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "RU" },
  { value: "en", label: "EN" },
];

const STORAGE_KEYS = {
  edition: "dnd.firegory.sourceMetadata.edition",
  language: "dnd.firegory.sourceMetadata.language",
} as const;

export function SourceMetadataEditor({ source }: { source: SourceWithStats }) {
  const { t } = useUiLanguage();
  const [title, setTitle] = useState(source.title);
  const [category, setCategory] = useState(source.category);
  const [edition, setEdition] = useState(source.edition);
  const [language, setLanguage] = useState(source.language);
  const [accessTier, setAccessTier] = useState(source.accessTier);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.edition, edition);
  }, [edition]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.language, language);
  }, [language]);

  const categoryOptions = [
    { value: "core_rules", label: t("coreRules") },
    { value: "official_supplement", label: t("supplements") },
    { value: "homebrew", label: t("homebrew") },
  ];
  const editionOptions = [
    { value: "5.5e", label: "D&D 5.5e" },
    { value: "5e", label: "D&D 5e" },
  ];
  const accessOptions = [
    { value: "open", label: t("open") },
    { value: "premium", label: t("premium") },
    { value: "personal", label: t("personal") },
  ];

  async function save() {
    setStatus("saving");
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/sources/${source.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, category, edition, language, accessTier }),
      });
      const data = await response.json();
      if (!response.ok) {
        setStatus("error");
        setMessage(data.error ?? t("saveFailed"));
        return;
      }
      setStatus("saved");
      setMessage(t("saved"));
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : t("networkError"));
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">{t("sourceMetadata")}</h2>
          <p className="mt-1 text-sm text-text-muted">{t("sourceMetadataDescription")}</p>
        </div>
        {message && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status === "error" ? "bg-danger/15 text-danger" : "bg-success/15 text-success"}`}>
            {message}
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{t("title")}</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <AppSelect label={t("category")} value={category} options={categoryOptions} onChange={(value) => setCategory(value as typeof category)} />
        <AppSelect label={t("edition")} value={edition} options={editionOptions} onChange={(value) => setEdition(value as typeof edition)} />
        <AppSelect label={t("language")} value={language} options={LANGUAGE_OPTIONS} onChange={(value) => setLanguage(value as typeof language)} />
        <AppSelect label={t("access")} value={accessTier} options={accessOptions} onChange={(value) => setAccessTier(value as typeof accessTier)} />
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === "saving"}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {status === "saving" ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          onClick={() => {
            setTitle(source.title);
            setCategory(source.category);
            setEdition(source.edition);
            setLanguage(source.language);
            setAccessTier(source.accessTier);
            setStatus("idle");
            setMessage(null);
          }}
          className="rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/30 hover:text-accent"
        >
          {t("reset")}
        </button>
      </div>
    </section>
  );
}
