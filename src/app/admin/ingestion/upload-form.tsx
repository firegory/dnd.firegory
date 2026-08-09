"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AppSelect } from "../../../components/ui/select";
import { useUiLanguage } from "../../../components/ui/i18n";
import {
  createUploadSourceFormState,
  resetUploadSourceFormState,
  type UploadSourceFormState,
} from "./upload-source-form";

const LANGUAGES = [
  { value: "ru", label: "RU" },
  { value: "en", label: "EN" },
] as const;

const STORAGE_KEYS = {
  edition: "dnd.firegory.upload.edition",
  language: "dnd.firegory.upload.language",
} as const;

type FormStatus = "idle" | "uploading" | "success" | "error";

type UploadResponse = Partial<{
  sourceId: string;
  jobId: string;
  error: string;
}>;

async function readUploadResponse(response: Response): Promise<UploadResponse> {
  const text = await response.text();
  if (!text.trim()) return {};

  try {
    return JSON.parse(text) as UploadResponse;
  } catch {
    return { error: text };
  }
}

export function UploadForm({ onSuccess }: { onSuccess?: () => void }) {
  const { t } = useUiLanguage();
  const [file, setFile] = useState<File | null>(null);
  const [fields, setFields] = useState(createUploadSourceFormState);
  const [formStatus, setFormStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceId: string; jobId: string } | null>(null);
  const router = useRouter();

  const isUploading = formStatus === "uploading";

  function setField<K extends keyof UploadSourceFormState>(field: K, value: UploadSourceFormState[K]) {
    setFields((current) => ({ ...current, [field]: value }));
  }

  useEffect(() => {
    const storedEdition = window.localStorage.getItem(STORAGE_KEYS.edition);
    const storedLanguage = window.localStorage.getItem(STORAGE_KEYS.language);
    if (storedEdition || storedLanguage) {
      queueMicrotask(() => setFields((current) => ({
        ...current,
        ...(storedEdition ? { edition: storedEdition } : {}),
        ...(storedLanguage ? { language: storedLanguage } : {}),
      })));
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.edition, fields.edition);
  }, [fields.edition]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.language, fields.language);
  }, [fields.language]);

  const categories = [
    { value: "core_rules", label: t("coreRules"), description: t("coreRulesDescription") },
    { value: "official_supplement", label: t("officialSupplement"), description: t("supplementsDescription") },
    { value: "homebrew", label: t("homebrew"), description: t("homebrewDescription") },
  ] as const;
  const editions = [
    { value: "5.5e", label: "D&D 5.5e", description: t("dnd2024Rules") },
    { value: "5e", label: "D&D 5e" },
  ] as const;
  const accessTiers = [
    { value: "open", label: t("open"), description: t("allUsers") },
    { value: "premium", label: t("premium"), description: t("subscribers") },
    { value: "personal", label: t("personal"), description: t("ownerOnly") },
  ] as const;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!file) {
      setFormStatus("error");
      setErrorMessage(t("selectPdfError"));
      return;
    }
    if (!fields.title.trim()) {
      setFormStatus("error");
      setErrorMessage(t("enterTitleError"));
      return;
    }

    void doUpload();
  }

  async function doUpload() {
    if (!file) return;

    setFormStatus("uploading");
    setErrorMessage(null);
    setResult(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("title", fields.title.trim());
    formData.append("category", fields.category);
    formData.append("edition", fields.edition);
    formData.append("language", fields.language);
    formData.append("accessTier", fields.accessTier);
    formData.append("canonicalSourceId", fields.canonicalSourceId);
    formData.append("publicationCode", fields.publicationCode);
    formData.append("publicationTitle", fields.publicationTitle || fields.title.trim());
    formData.append("publisher", fields.publisher);
    formData.append("releaseYear", fields.releaseYear);
    formData.append("revision", fields.revision);
    formData.append("originUrl", fields.originUrl);
    formData.append("originId", fields.originId);
    formData.append("attribution", fields.attribution);
    formData.append("sourcePriority", fields.sourcePriority);
    formData.append("canonicalBookId", fields.canonicalBookId);
    formData.append("license", fields.license);

    try {
      const response = await fetch("/api/admin/ingestion/upload", {
        method: "POST",
        body: formData,
      });

      if (response.status === 401) {
        router.push("/login");
        return;
      }

      const data = await readUploadResponse(response);

      if (!response.ok) {
        setFormStatus("error");
        setErrorMessage(data.error ?? t("uploadFailedHttp", { status: response.status }));
        return;
      }

      if (!data.sourceId || !data.jobId) {
        setFormStatus("error");
        setErrorMessage(t("uploadUnexpected"));
        return;
      }

      setFormStatus("success");
      setResult({ sourceId: data.sourceId, jobId: data.jobId });
      setFile(null);
      setFields((current) => resetUploadSourceFormState(current));
      const fileInput = document.getElementById("pdf-file-input") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      onSuccess?.();
    } catch (err) {
      setFormStatus("error");
      setErrorMessage(err instanceof Error ? err.message : t("networkError"));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="mb-2 block text-sm font-semibold text-text-secondary" htmlFor="pdf-file-input">
          {t("pdfFile")}
        </label>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <label className="cursor-pointer rounded-xl border border-dashed border-border bg-primary/40 px-6 py-4 text-center transition-colors hover:border-accent/40 hover:bg-primary/60">
            <input
              id="pdf-file-input"
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                if (formStatus === "success" || formStatus === "error") {
                  setFormStatus("idle");
                  setErrorMessage(null);
                }
              }}
            />
            <span className="block font-mono text-xs font-bold tracking-widest text-accent uppercase">
              PDF
            </span>
            <p className="mt-2 text-sm text-text-muted">{t("clickOrDropFile")}</p>
            <p className="mt-1 text-xs text-text-muted">{t("pdfLimit")}</p>
          </label>
          <div className="text-sm text-text-muted">
            <p>
              {t("selected")}: <span className="text-text-secondary">{file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : "—"}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-text-secondary">{t("titleRequired")}</span>
          <input
            type="text"
            value={fields.title}
            onChange={(e) => {
              setField("title", e.target.value);
              if (formStatus === "success" || formStatus === "error") {
                setFormStatus("idle");
                setErrorMessage(null);
              }
            }}
            placeholder="Player's Handbook 2024 (ru)"
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary placeholder-text-muted outline-none focus:border-focus focus:ring-2 focus:ring-focus/20"
          />
        </label>
        <AppSelect label={t("category")} value={fields.category} options={categories} onChange={(value) => setField("category", value)} disabled={isUploading} />
        <AppSelect label={t("edition")} value={fields.edition} options={editions} onChange={(value) => setField("edition", value)} disabled={isUploading} />
        <AppSelect label={t("language")} value={fields.language} options={LANGUAGES} onChange={(value) => setField("language", value)} disabled={isUploading} />
        <AppSelect label={t("accessLevel")} value={fields.accessTier} options={accessTiers} onChange={(value) => setField("accessTier", value)} disabled={isUploading} />
        <UploadTextField label={t("canonicalSourceId")} value={fields.canonicalSourceId} onChange={(value) => setField("canonicalSourceId", value)} disabled={isUploading} />
        <UploadTextField label={t("publicationCode")} value={fields.publicationCode} onChange={(value) => setField("publicationCode", value)} disabled={isUploading} />
        <UploadTextField label={t("publicationTitle")} value={fields.publicationTitle} onChange={(value) => setField("publicationTitle", value)} disabled={isUploading} />
        <UploadTextField label={t("publisher")} value={fields.publisher} onChange={(value) => setField("publisher", value)} disabled={isUploading} />
        <UploadTextField label={t("releaseYear")} value={fields.releaseYear} onChange={(value) => setField("releaseYear", value)} disabled={isUploading} type="number" />
        <UploadTextField label={t("revision")} value={fields.revision} onChange={(value) => setField("revision", value)} disabled={isUploading} />
        <UploadTextField label={t("externalOriginUrl")} value={fields.originUrl} onChange={(value) => setField("originUrl", value)} disabled={isUploading} type="url" />
        <UploadTextField label={t("externalOriginId")} value={fields.originId} onChange={(value) => setField("originId", value)} disabled={isUploading} />
        <UploadTextField label={t("attribution")} value={fields.attribution} onChange={(value) => setField("attribution", value)} disabled={isUploading} />
        <UploadTextField label={t("sourcePriority")} value={fields.sourcePriority} onChange={(value) => setField("sourcePriority", value)} disabled={isUploading} type="number" />
        <UploadTextField label={t("canonicalBookId")} value={fields.canonicalBookId} onChange={(value) => setField("canonicalBookId", value)} disabled={isUploading} />
        <UploadTextField label={t("license")} value={fields.license} onChange={(value) => setField("license", value)} disabled={isUploading} />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          disabled={isUploading}
        >
          {isUploading ? t("uploading") : t("uploadAndProcess")}
        </button>
        {formStatus === "success" && result && (
          <span className="text-sm font-semibold text-status-success">
            {t("sourceReady", { source: result.sourceId.slice(0, 8), job: result.jobId.slice(0, 8) })}
          </span>
        )}
        {formStatus === "error" && errorMessage && (
          <span className="text-sm font-semibold text-danger">{errorMessage}</span>
        )}
      </div>
    </form>
  );
}

function UploadTextField({
  label,
  value,
  onChange,
  disabled,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  type?: "text" | "number" | "url";
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-semibold text-text-secondary">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:opacity-50"
      />
    </label>
  );
}
