"use client";

import { useState, useRef, type FormEvent } from "react";
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
  const formRef = useRef<HTMLFormElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const isUploading = formStatus === "uploading";
  const canSubmit = file !== null && title.trim().length > 0 && !isUploading;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file || !title.trim()) return;

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

      const data = await response.json();

      if (!response.ok) {
        setFormStatus("error");
        setErrorMessage(data.error ?? "Upload failed.");
        return;
      }

      setFormStatus("success");
      setResult({ sourceId: data.sourceId, jobId: data.jobId });
      // Reset form state completely — both React state and DOM inputs
      setFile(null);
      setTitle("");
      if (fileInputRef.current) fileInputRef.current.value = "";
      formRef.current?.reset();
      onSuccess?.();
    } catch (err) {
      setFormStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0] ?? null;
    setFile(selected);
    // Clear success/error state when user changes the file
    if (formStatus === "success" || formStatus === "error") {
      setFormStatus("idle");
    }
  }

  function handleTitleChange(e: React.ChangeEvent<HTMLInputElement>) {
    setTitle(e.target.value);
    if (formStatus === "success" || formStatus === "error") {
      setFormStatus("idle");
    }
  }

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="upload-form">
      <label className="form-label">
        PDF file
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          onChange={handleFileChange}
          required
          disabled={isUploading}
        />
      </label>

      <label className="form-label">
        Source title
        <input
          type="text"
          value={title}
          onChange={handleTitleChange}
          placeholder="e.g. Player's Handbook"
          required
          disabled={isUploading}
        />
      </label>

      <div className="form-row">
        <label className="form-label">
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)} disabled={isUploading}>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Edition
          <select value={edition} onChange={(e) => setEdition(e.target.value)} disabled={isUploading}>
            {EDITIONS.map((ed) => (
              <option key={ed.value} value={ed.value}>{ed.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Language
          <select value={language} onChange={(e) => setLanguage(e.target.value)} disabled={isUploading}>
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>{l.label}</option>
            ))}
          </select>
        </label>

        <label className="form-label">
          Access tier
          <select value={accessTier} onChange={(e) => setAccessTier(e.target.value)} disabled={isUploading}>
            {ACCESS_TIERS.map((a) => (
              <option key={a.value} value={a.value}>{a.label}</option>
            ))}
          </select>
        </label>
      </div>

      <button type="submit" disabled={!canSubmit}>
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
