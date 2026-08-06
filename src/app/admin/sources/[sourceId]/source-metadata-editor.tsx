"use client";

import { useState } from "react";
import { AppSelect } from "../../../../components/ui/select";
import { useUiLanguage } from "../../../../components/ui/i18n";
import type { SourceWithStats } from "../../../../server/admin/source-view";
import {
  createSourceMetadataFormState,
  sourceMetadataPatchFromForm,
  type SourceMetadataFormState,
} from "./source-metadata-form";

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "RU" },
  { value: "en", label: "EN" },
];

export function SourceMetadataEditor({ source }: { source: SourceWithStats }) {
  const { t } = useUiLanguage();
  const [form, setForm] = useState(() => createSourceMetadataFormState(source));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  function setField<K extends keyof SourceMetadataFormState>(field: K, value: SourceMetadataFormState[K]) {
    setForm((current) => ({ ...current, [field]: value }));
  }

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
        body: JSON.stringify(sourceMetadataPatchFromForm(form)),
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
            value={form.title}
            onChange={(event) => setField("title", event.target.value)}
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <AppSelect label={t("category")} value={form.category} options={categoryOptions} onChange={(value) => setField("category", value as SourceMetadataFormState["category"])} />
        <AppSelect label={t("edition")} value={form.edition} options={editionOptions} onChange={(value) => setField("edition", value as SourceMetadataFormState["edition"])} />
        <AppSelect label={t("language")} value={form.language} options={LANGUAGE_OPTIONS} onChange={(value) => setField("language", value as SourceMetadataFormState["language"])} />
        <AppSelect label={t("access")} value={form.accessTier} options={accessOptions} onChange={(value) => setField("accessTier", value as SourceMetadataFormState["accessTier"])} />
        <TextField label={t("ownerUserId")} value={form.ownerUserId} onChange={(value) => setField("ownerUserId", value)} disabled={form.accessTier !== "personal"} />
        <TextField label={t("canonicalSourceId")} value={form.canonicalSourceId} onChange={(value) => setField("canonicalSourceId", value)} />
        <TextField label={t("publicationCode")} value={form.publicationCode} onChange={(value) => setField("publicationCode", value)} />
        <TextField label={t("publicationTitle")} value={form.publicationTitle} onChange={(value) => setField("publicationTitle", value)} />
        <TextField label={t("publisher")} value={form.publisher} onChange={(value) => setField("publisher", value)} />
        <TextField label={t("releaseYear")} value={form.releaseYear} onChange={(value) => setField("releaseYear", value)} type="number" />
        <TextField label={t("revision")} value={form.revision} onChange={(value) => setField("revision", value)} />
        <TextField label={t("externalOriginUrl")} value={form.originUrl} onChange={(value) => setField("originUrl", value)} type="url" />
        <TextField label={t("externalOriginId")} value={form.originId} onChange={(value) => setField("originId", value)} />
        <TextField label={t("attribution")} value={form.attribution} onChange={(value) => setField("attribution", value)} />
        <TextField label={t("sourcePriority")} value={form.sourcePriority} onChange={(value) => setField("sourcePriority", value)} type="number" />
        <TextField label={t("canonicalBookId")} value={form.canonicalBookId} onChange={(value) => setField("canonicalBookId", value)} />
        <TextField label={t("license")} value={form.license} onChange={(value) => setField("license", value)} />
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
            setForm(createSourceMetadataFormState(source));
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

function TextField({
  label,
  value,
  onChange,
  type = "text",
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: "text" | "number" | "url";
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
      />
    </label>
  );
}
