"use client";

import { useEffect, useState } from "react";
import { AppSelect } from "../../../../components/ui/select";
import { useUiLanguage } from "../../../../components/ui/i18n";
import type { SourceWithStats } from "../../../../server/admin/source-view";

const LANGUAGE_OPTIONS = [
  { value: "ru", label: "RU" },
  { value: "en", label: "EN" },
];

const EDITION_VALUES = new Set(["5.5e", "5e"]);
const LANGUAGE_VALUES = new Set(["ru", "en"]);

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
  const [ownerUserId, setOwnerUserId] = useState(source.ownerUserId ?? "");
  const [canonicalSourceId, setCanonicalSourceId] = useState(source.canonicalSourceId ?? "");
  const [publicationCode, setPublicationCode] = useState(source.publication.code ?? "");
  const [publicationTitle, setPublicationTitle] = useState(source.publication.title);
  const [publisher, setPublisher] = useState(source.publication.publisher ?? "");
  const [releaseYear, setReleaseYear] = useState(source.publication.releaseYear?.toString() ?? "");
  const [revision, setRevision] = useState(source.publication.revision ?? "");
  const [originUrl, setOriginUrl] = useState(source.publication.origin?.url ?? "");
  const [originId, setOriginId] = useState(source.publication.origin?.id ?? "");
  const [attribution, setAttribution] = useState(source.publication.attribution ?? "");
  const [sourcePriority, setSourcePriority] = useState(source.publication.sourcePriority.toString());
  const [canonicalBookId, setCanonicalBookId] = useState(source.publication.canonicalBookId ?? "");
  const [license, setLicense] = useState(source.license ?? "");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    const storedEdition = window.localStorage.getItem(STORAGE_KEYS.edition);
    const storedLanguage = window.localStorage.getItem(STORAGE_KEYS.language);
    if (storedEdition && EDITION_VALUES.has(storedEdition)) {
      queueMicrotask(() => setEdition(storedEdition as typeof edition));
    }
    if (storedLanguage && LANGUAGE_VALUES.has(storedLanguage)) {
      queueMicrotask(() => setLanguage(storedLanguage as typeof language));
    }
  }, []);

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
        body: JSON.stringify({
          canonicalSourceId: canonicalSourceId || null,
          title,
          category,
          edition,
          language,
          accessTier,
          ownerUserId: accessTier === "personal" ? ownerUserId || null : null,
          publication: {
            code: publicationCode || null,
            title: publicationTitle,
            publisher: publisher || null,
            releaseYear: releaseYear ? Number(releaseYear) : null,
            revision: revision || null,
            origin: originUrl || originId ? { url: originUrl || null, id: originId || null } : null,
            attribution: attribution || null,
            sourcePriority: Number(sourcePriority),
            canonicalBookId: canonicalBookId || null,
          },
          license: license || null,
        }),
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
        <TextField label={t("ownerUserId")} value={ownerUserId} onChange={setOwnerUserId} disabled={accessTier !== "personal"} />
        <TextField label={t("canonicalSourceId")} value={canonicalSourceId} onChange={setCanonicalSourceId} />
        <TextField label={t("publicationCode")} value={publicationCode} onChange={setPublicationCode} />
        <TextField label={t("publicationTitle")} value={publicationTitle} onChange={setPublicationTitle} />
        <TextField label={t("publisher")} value={publisher} onChange={setPublisher} />
        <TextField label={t("releaseYear")} value={releaseYear} onChange={setReleaseYear} type="number" />
        <TextField label={t("revision")} value={revision} onChange={setRevision} />
        <TextField label={t("externalOriginUrl")} value={originUrl} onChange={setOriginUrl} type="url" />
        <TextField label={t("externalOriginId")} value={originId} onChange={setOriginId} />
        <TextField label={t("attribution")} value={attribution} onChange={setAttribution} />
        <TextField label={t("sourcePriority")} value={sourcePriority} onChange={setSourcePriority} type="number" />
        <TextField label={t("canonicalBookId")} value={canonicalBookId} onChange={setCanonicalBookId} />
        <TextField label={t("license")} value={license} onChange={setLicense} />
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
            setOwnerUserId(source.ownerUserId ?? "");
            setCanonicalSourceId(source.canonicalSourceId ?? "");
            setPublicationCode(source.publication.code ?? "");
            setPublicationTitle(source.publication.title);
            setPublisher(source.publication.publisher ?? "");
            setReleaseYear(source.publication.releaseYear?.toString() ?? "");
            setRevision(source.publication.revision ?? "");
            setOriginUrl(source.publication.origin?.url ?? "");
            setOriginId(source.publication.origin?.id ?? "");
            setAttribution(source.publication.attribution ?? "");
            setSourcePriority(source.publication.sourcePriority.toString());
            setCanonicalBookId(source.publication.canonicalBookId ?? "");
            setLicense(source.license ?? "");
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
