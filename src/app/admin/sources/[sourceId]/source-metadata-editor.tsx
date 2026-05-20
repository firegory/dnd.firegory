"use client";

import { useState } from "react";
import { AppSelect } from "../../../../components/ui/select";
import type { SourceWithStats } from "../../../../server/admin/source-view";

const CATEGORY_OPTIONS = [
  { value: "core_rules", label: "Core rules" },
  { value: "official_supplement", label: "Supplements" },
  { value: "homebrew", label: "Homebrew" },
];

const EDITION_OPTIONS = [
  { value: "5.5e", label: "D&D 5.5e" },
  { value: "5e", label: "D&D 5e" },
];

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
];

const ACCESS_OPTIONS = [
  { value: "open", label: "Open" },
  { value: "premium", label: "Premium" },
  { value: "personal", label: "Personal" },
];

export function SourceMetadataEditor({ source }: { source: SourceWithStats }) {
  const [title, setTitle] = useState(source.title);
  const [category, setCategory] = useState(source.category);
  const [edition, setEdition] = useState(source.edition);
  const [language, setLanguage] = useState(source.language);
  const [accessTier, setAccessTier] = useState(source.accessTier);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

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
        setMessage(data.error ?? "Не удалось сохранить изменения.");
        return;
      }
      setStatus("saved");
      setMessage("Изменения сохранены");
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : "Network error.");
    }
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">Метаданные источника</h2>
          <p className="mt-1 text-sm text-text-muted">Редактирование реальной записи sources.</p>
        </div>
        {message && (
          <span className={`rounded-full px-3 py-1 text-xs font-semibold ${status === "error" ? "bg-danger/15 text-danger" : "bg-success/15 text-success"}`}>
            {message}
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">Название</span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <AppSelect label="Категория" value={category} options={CATEGORY_OPTIONS} onChange={(value) => setCategory(value as typeof category)} />
        <AppSelect label="Редакция" value={edition} options={EDITION_OPTIONS} onChange={(value) => setEdition(value as typeof edition)} />
        <AppSelect label="Язык" value={language} options={LANGUAGE_OPTIONS} onChange={(value) => setLanguage(value as typeof language)} />
        <AppSelect label="Доступ" value={accessTier} options={ACCESS_OPTIONS} onChange={(value) => setAccessTier(value as typeof accessTier)} />
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={status === "saving"}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
        >
          {status === "saving" ? "Сохраняем…" : "Сохранить"}
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
          Сбросить
        </button>
      </div>
    </section>
  );
}
