"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { AppSelect } from "../../../components/ui/select";

const CATEGORIES = [
  { value: "core_rules", label: "Core Rules", description: "Базовые правила" },
  { value: "official_supplement", label: "Official Supplement" },
  { value: "homebrew", label: "Homebrew" },
] as const;

const EDITIONS = [
  { value: "5.5e", label: "D&D 5.5e", description: "Правила 2024" },
  { value: "5e", label: "D&D 5e" },
] as const;

const LANGUAGES = [
  { value: "ru", label: "Русский" },
  { value: "en", label: "English" },
] as const;

const ACCESS_TIERS = [
  { value: "open", label: "Open", description: "Все пользователи" },
  { value: "premium", label: "Premium", description: "Подписчики" },
  { value: "personal", label: "Personal", description: "Только владелец" },
] as const;

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
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("core_rules");
  const [edition, setEdition] = useState<string>("5.5e");
  const [language, setLanguage] = useState<string>("ru");
  const [accessTier, setAccessTier] = useState<string>("open");
  const [formStatus, setFormStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceId: string; jobId: string } | null>(null);
  const router = useRouter();

  const isUploading = formStatus === "uploading";

  function handleSubmit(e: FormEvent) {
    e.preventDefault();

    if (!file) {
      setFormStatus("error");
      setErrorMessage("Please select a PDF file.");
      return;
    }
    if (!title.trim()) {
      setFormStatus("error");
      setErrorMessage("Please enter a source title.");
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
        setErrorMessage(data.error ?? `Upload failed with HTTP ${response.status}.`);
        return;
      }

      if (!data.sourceId || !data.jobId) {
        setFormStatus("error");
        setErrorMessage("Upload succeeded, but the server returned an unexpected response.");
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
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div>
        <label className="mb-2 block text-sm font-semibold text-text-secondary" htmlFor="pdf-file-input">
          PDF файл
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
            <p className="mt-2 text-sm text-text-muted">Нажмите или перетащите файл</p>
            <p className="mt-1 text-xs text-text-muted">PDF, до 200 MB</p>
          </label>
          <div className="text-sm text-text-muted">
            <p>
              Выбран: <span className="text-text-secondary">{file ? `${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB)` : "—"}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-text-secondary">Название *</span>
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
        <AppSelect label="Категория" value={category} options={CATEGORIES} onChange={setCategory} disabled={isUploading} />
        <AppSelect label="Редакция" value={edition} options={EDITIONS} onChange={setEdition} disabled={isUploading} />
        <AppSelect label="Язык" value={language} options={LANGUAGES} onChange={setLanguage} disabled={isUploading} />
        <AppSelect label="Уровень доступа" value={accessTier} options={ACCESS_TIERS} onChange={setAccessTier} disabled={isUploading} />
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
          disabled={isUploading}
        >
          {isUploading ? "Загрузка…" : "Загрузить и обработать"}
        </button>
        {formStatus === "success" && result && (
          <span className="text-sm font-semibold text-success">
            Готово: source {result.sourceId.slice(0, 8)}, job {result.jobId.slice(0, 8)}
          </span>
        )}
        {formStatus === "error" && errorMessage && (
          <span className="text-sm font-semibold text-danger">{errorMessage}</span>
        )}
      </div>
    </form>
  );
}
