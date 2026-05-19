"use client";

import { useState, useRef, type FormEvent } from "react";

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

type UploadStatus = "idle" | "uploading" | "success" | "error";

export function UploadForm({ onSuccess }: { onSuccess?: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>("core_rules");
  const [edition, setEdition] = useState<string>("5e");
  const [language, setLanguage] = useState<string>("en");
  const [accessTier, setAccessTier] = useState<string>("open");
  const [status, setStatus] = useState<UploadStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<{ sourceId: string; jobId: string } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    setStatus("uploading");
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

      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setErrorMessage(data.error ?? "Upload failed.");
        return;
      }

      setStatus("success");
      setResult({ sourceId: data.sourceId, jobId: data.jobId });
      setFile(null);
      setTitle("");
      formRef.current?.reset();
      onSuccess?.();
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="upload-form">
      <label className="form-label">
        PDF file
        <input
          type="file"
          accept=".pdf,application/pdf"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
          disabled={status === "uploading"}
        />
      </label>

      <label className="form-label">
        Source title
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Player's Handbook"
          required
          disabled={status === "uploading"}
        />
      </label>

      <div className="form-row">
        <label className="form-label">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={status === "uploading"}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Edition
          <select value={edition} onChange={(e) => setEdition(e.target.value)} disabled={status === "uploading"}>
            {EDITIONS.map((ed) => (
              <option key={ed.value} value={ed.value}>{ed.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={status === "uploading"}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Access tier
          <select value={accessTier} onChange={(e) => setAccessTier(e.target.value)} disabled={status === "uploading"}>
            {ACCESS_TIERS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </label>
      </div>

      <button type="submit" disabled={!file || !title.trim() || status === "uploading"}>
        {status === "uploading" ? "Uploading…" : "Upload and ingest"}
      </button>

      {status === "error" && errorMessage && (
        <p className="form-error">{errorMessage}</p>
      )}

      {status === "success" && result && (
        <p className="form-success">
          Upload queued. Job <code>{result.jobId}</code> created for source <code>{result.sourceId}</code>.
        </p>
      )}
    </form>
  );
}
