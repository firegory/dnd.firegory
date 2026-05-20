"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

const CATEGORIES = [
  { value: "core_rules", label: "Core Rules" },
  { value: "official_supplement", label: "Official Supplement" },
  { value: "homebrew", label: "Homebrew" },
] as const;

const EDITIONS = [
  { value: "5e", label: "5e" },
  { value: "5.5e", label: "5.5e" },
] as const;

const LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
] as const;

const ACCESS_TIERS = [
  { value: "open", label: "Open / SRD" },
  { value: "premium", label: "Premium (shared)" },
  { value: "personal", label: "Personal" },
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
  const [edition, setEdition] = useState<string>("5e");
  const [language, setLanguage] = useState<string>("en");
  const [accessTier, setAccessTier] = useState<string>("open");
  const [formStatus, setFormStatus] = useState<FormStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceId: string; jobId: string } | null>(null);
  const router = useRouter();

  const isUploading = formStatus === "uploading";

  // Validate in submit, not via disabled prop
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

      // Reset form
      setFile(null);
      setTitle("");
      // Reset the native file input via DOM
      const fileInput = document.getElementById("pdf-file-input") as HTMLInputElement | null;
      if (fileInput) fileInput.value = "";
      onSuccess?.();
    } catch (err) {
      setFormStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="upload-form">
      <div className="form-group">
        <label htmlFor="pdf-file-input">PDF file</label>
        <input
          id="pdf-file-input"
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null);
            if (formStatus === "success" || formStatus === "error") {
              setFormStatus("idle");
              setErrorMessage(null);
            }
          }}
        />
        {file && (
          <span className="hint">Selected: {file.name} ({(file.size / 1024 / 1024).toFixed(1)} MB)</span>
        )}
      </div>

      <div className="form-group">
        <label htmlFor="source-title-input">Source title</label>
        <input
          id="source-title-input"
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            if (formStatus === "success" || formStatus === "error") {
              setFormStatus("idle");
              setErrorMessage(null);
            }
          }}
          placeholder="e.g. Player's Handbook"
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="category-select">Category</label>
          <select id="category-select" value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="edition-select">Edition</label>
          <select id="edition-select" value={edition} onChange={(e) => setEdition(e.target.value)}>
            {EDITIONS.map((ed) => (
              <option key={ed.value} value={ed.value}>{ed.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="language-select">Language</label>
          <select id="language-select" value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </div>

        <div className="form-group">
          <label htmlFor="access-tier-select">Access tier</label>
          <select id="access-tier-select" value={accessTier} onChange={(e) => setAccessTier(e.target.value)}>
            {ACCESS_TIERS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/*
        NOTE: Button is NEVER disabled via HTML attribute.
        This avoids the persistent cursor:not-allowed / unclickable bug
        where React state and DOM disabled attribute could get out of sync
        during Next.js client hydration.
        Validation happens in handleSubmit instead.
      */}
      <button
        type="submit"
        className="upload-submit"
      >
        {isUploading ? "Uploading…" : "Upload and ingest"}
      </button>

      {formStatus === "error" && errorMessage && (
        <p className="form-error">{errorMessage}</p>
      )}

      {formStatus === "success" && result && (
        <p className="form-success">
          Upload queued. Job <code>{result.jobId}</code> created for source <code>{result.sourceId}</code>.
        </p>
      )}
    </form>
  );
}
