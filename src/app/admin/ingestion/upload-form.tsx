"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AppSelect } from "../../../components/ui/select";
import { useUiLanguage } from "../../../components/ui/i18n";

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
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("core_rules");
  const [edition, setEdition] = useState<string>("5.5e");
  const [language, setLanguage] = useState<string>("ru");
  const [accessTier, setAccessTier] = useState<string>("open");
  const [canonicalSourceId, setCanonicalSourceId] = useState("");
  const [publicationCode, setPublicationCode] = useState("");
  const [publicationTitle, setPublicationTitle] = useState("");
  const [publisher, setPublisher] = useState("");
  const [releaseYear, setReleaseYear] = useState("");
  const [revision, setRevision] = useState("");
  const [originUrl, setOriginUrl] = useState("");
  const [originId, setOriginId] = useState("");
  const [attribution, setAttribution] = useState("");
  const [sourcePriority, setSourcePriority] = useState("0");
  const [canonicalBookId, setCanonicalBookId] = useState("");
  const [license, setLicense] = useState("");
  const [formStatus, setFormStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceId: string; jobId: string } | null>(null);
  const router = useRouter();

  const isUploading = formStatus === "uploading";

  useEffect(() => {
    const storedEdition = window.localStorage.getItem(STORAGE_KEYS.edition);
    const storedLanguage = window.localStorage.getItem(STORAGE_KEYS.language);
    if (storedEdition) queueMicrotask(() => setEdition(storedEdition));
    if (storedLanguage) queueMicrotask(() => setLanguage(storedLanguage));
  }, []);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.edition, edition);
  }, [edition]);

  useEffect(() => {
    window.localStorage.setItem(STORAGE_KEYS.language, language);
  }, [language]);

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
    if (!title.trim()) {
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
    formData.append("title", title.trim());
    formData.append("category", category);
    formData.append("edition", edition);
    formData.append("language", language);
    formData.append("accessTier", accessTier);
    formData.append("canonicalSourceId", canonicalSourceId);
    formData.append("publicationCode", publicationCode);
    formData.append("publicationTitle", publicationTitle || title.trim());
    formData.append("publisher", publisher);
    formData.append("releaseYear", releaseYear);
    formData.append("revision", revision);
    formData.append("originUrl", originUrl);
    formData.append("originId", originId);
    formData.append("attribution", attribution);
    formData.append("sourcePriority", sourcePriority);
    formData.append("canonicalBookId", canonicalBookId);
    formData.append("license", license);

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
      setTitle("");
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
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              if (formStatus === "success" || formStatus === "error") {
                setFormStatus("idle");
                setErrorMessage(null);
              }
            }}
            placeholder="Player's Handbook 2024 (ru)"
            className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent focus:ring-2 focus:ring-accent/20"
          />
        </label>
        <AppSelect label={t("category")} value={category} options={categories} onChange={setCategory} disabled={isUploading} />
        <AppSelect label={t("edition")} value={edition} options={editions} onChange={setEdition} disabled={isUploading} />
        <AppSelect label={t("language")} value={language} options={LANGUAGES} onChange={setLanguage} disabled={isUploading} />
        <AppSelect label={t("accessLevel")} value={accessTier} options={accessTiers} onChange={setAccessTier} disabled={isUploading} />
        <UploadTextField label={t("canonicalSourceId")} value={canonicalSourceId} onChange={setCanonicalSourceId} disabled={isUploading} />
        <UploadTextField label={t("publicationCode")} value={publicationCode} onChange={setPublicationCode} disabled={isUploading} />
        <UploadTextField label={t("publicationTitle")} value={publicationTitle} onChange={setPublicationTitle} disabled={isUploading} />
        <UploadTextField label={t("publisher")} value={publisher} onChange={setPublisher} disabled={isUploading} />
        <UploadTextField label={t("releaseYear")} value={releaseYear} onChange={setReleaseYear} disabled={isUploading} type="number" />
        <UploadTextField label={t("revision")} value={revision} onChange={setRevision} disabled={isUploading} />
        <UploadTextField label={t("externalOriginUrl")} value={originUrl} onChange={setOriginUrl} disabled={isUploading} type="url" />
        <UploadTextField label={t("externalOriginId")} value={originId} onChange={setOriginId} disabled={isUploading} />
        <UploadTextField label={t("attribution")} value={attribution} onChange={setAttribution} disabled={isUploading} />
        <UploadTextField label={t("sourcePriority")} value={sourcePriority} onChange={setSourcePriority} disabled={isUploading} type="number" />
        <UploadTextField label={t("canonicalBookId")} value={canonicalBookId} onChange={setCanonicalBookId} disabled={isUploading} />
        <UploadTextField label={t("license")} value={license} onChange={setLicense} disabled={isUploading} />
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
          <span className="text-sm font-semibold text-success">
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
        className="rounded-lg border border-border bg-primary/60 px-4 py-2.5 text-sm text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:opacity-50"
      />
    </label>
  );
}
