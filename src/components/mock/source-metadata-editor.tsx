"use client";

import { useState } from "react";
import { MockSelect } from "./select";
import type { MockSource } from "./data";

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

export function SourceMetadataEditor({ source }: { source: MockSource }) {
  const [title, setTitle] = useState(source.title);
  const [category, setCategory] = useState(source.category);
  const [edition, setEdition] = useState(source.edition);
  const [language, setLanguage] = useState(source.language);
  const [accessTier, setAccessTier] = useState(source.accessTier);
  const [saved, setSaved] = useState(false);

  return (
    <section className="rounded-xl border border-border bg-surface p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-text-primary">
            Метаданные источника
          </h2>
          <p className="mt-1 text-sm text-text-muted">
            Mock-редактирование: показывает, как будет выглядеть будущая форма.
          </p>
        </div>
        {saved && (
          <span className="rounded-full bg-success/15 px-3 py-1 text-xs font-semibold text-success">
            Изменения сохранены
          </span>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 sm:col-span-2">
          <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">
            Название
          </span>
          <input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <MockSelect label="Категория" value={category} options={CATEGORY_OPTIONS} onChange={(value) => setCategory(value as typeof category)} />
        <MockSelect label="Редакция" value={edition} options={EDITION_OPTIONS} onChange={(value) => setEdition(value as typeof edition)} />
        <MockSelect label="Язык" value={language} options={LANGUAGE_OPTIONS} onChange={(value) => setLanguage(value as typeof language)} />
        <MockSelect label="Доступ" value={accessTier} options={ACCESS_OPTIONS} onChange={(value) => setAccessTier(value as typeof accessTier)} />
      </div>

      <div className="mt-5 flex gap-3">
        <button
          type="button"
          onClick={() => setSaved(true)}
          className="rounded-xl bg-accent px-5 py-2.5 text-sm font-semibold text-primary transition-opacity hover:opacity-90"
        >
          Сохранить mock
        </button>
        <button
          type="button"
          onClick={() => {
            setTitle(source.title);
            setCategory(source.category);
            setEdition(source.edition);
            setLanguage(source.language);
            setAccessTier(source.accessTier);
            setSaved(false);
          }}
          className="rounded-xl border border-border bg-surface px-5 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/30 hover:text-accent"
        >
          Сбросить
        </button>
      </div>
    </section>
  );
}
