"use client";

import { useState, type FormEvent } from "react";

const EDITIONS = [
  { value: "", label: "Any edition" },
  { value: "5e", label: "5e" },
  { value: "5.5e", label: "5.5e" },
] as const;

const LANGUAGES = [
  { value: "", label: "Any language" },
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
] as const;

const ANSWER_LANGUAGES = [
  { value: "en", label: "EN" },
  { value: "ru", label: "RU" },
] as const;

const CATEGORIES = [
  { value: "", label: "Any category" },
  { value: "core_rules", label: "Core Rules" },
  { value: "official_supplement", label: "Official Supplement" },
  { value: "homebrew", label: "Homebrew" },
] as const;

type Citation = Readonly<{
  quote: string;
  sourceTitle: string;
  edition: string;
  language: string;
  page: number | null;
  section: string | null;
  category: string;
}>;

type SearchResult = Readonly<{
  answer: string;
  citations: readonly Citation[];
  confident: boolean;
  retrievedChunks: number;
  meta: Readonly<{
    model?: string;
    retrievalTotal: number;
    retrievalHasMore: boolean;
    usage?: unknown;
  }>;
}>;

type SearchStatus = "idle" | "searching" | "success" | "error" | "no-support";

export function SearchForm() {
  const [query, setQuery] = useState("");
  const [edition, setEdition] = useState("");
  const [language, setLanguage] = useState("");
  const [answerLanguage, setAnswerLanguage] = useState<"en" | "ru">("en");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;

    setStatus("searching");
    setResult(null);
    setError(null);

    try {
      const body: Record<string, unknown> = {
        query: trimmed,
        answerLanguage,
      };
      if (edition) body.edition = edition;
      if (language) body.language = language;
      if (category) body.category = category;

      const response = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        setStatus("error");
        setError(data.error ?? "Search failed.");
        return;
      }

      setResult(data as SearchResult);

      if (!data.confident && (!data.citations || data.citations.length === 0)) {
        setStatus("no-support");
      } else {
        setStatus("success");
      }
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Network error.");
    }
  }

  return (
    <div className="search-container">
      <form onSubmit={handleSubmit} className="search-form">
        <div className="search-input-row">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask a D&D question…"
            className="search-query-input"
            maxLength={500}
            required
            disabled={status === "searching"}
            autoFocus
          />
          <button
            type="submit"
            className="search-submit"
            disabled={!query.trim() || status === "searching"}
          >
            {status === "searching" ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="search-toggles">
          <label className="toggle-group">
            <span className="toggle-label">Answer</span>
            <div className="toggle-buttons">
              {ANSWER_LANGUAGES.map((l) => (
                <button
                  key={l.value}
                  type="button"
                  className={`toggle-btn ${answerLanguage === l.value ? "active" : ""}`}
                  onClick={() => setAnswerLanguage(l.value as "en" | "ru")}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </label>

          <label className="toggle-group">
            <span className="toggle-label">Edition</span>
            <select
              value={edition}
              onChange={(e) => setEdition(e.target.value)}
              disabled={status === "searching"}
              className="toggle-select"
            >
              {EDITIONS.map((ed) => (
                <option key={ed.value} value={ed.value}>{ed.label}</option>
              ))}
            </select>
          </label>

          <label className="toggle-group">
            <span className="toggle-label">Source lang</span>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={status === "searching"}
              className="toggle-select"
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>

          <label className="toggle-group">
            <span className="toggle-label">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={status === "searching"}
              className="toggle-select"
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
        </div>
      </form>

      <SearchResults status={status} result={result} error={error} />
    </div>
  );
}

function SearchResults({
  status,
  result,
  error,
}: {
  status: SearchStatus;
  result: SearchResult | null;
  error: string | null;
}) {
  if (status === "idle") return null;

  if (status === "searching") {
    return (
      <div className="search-results" aria-live="polite">
        <div className="search-loading">
          <span className="loading-spinner" aria-hidden="true"></span>
          Searching for an answer…
        </div>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="search-results" aria-live="polite">
        <div className="search-error">
          <p className="form-error">{error ?? "Something went wrong."}</p>
        </div>
      </div>
    );
  }

  if (status === "no-support" && result) {
    return (
      <div className="search-results" aria-live="polite">
        <div className="answer-card no-support">
          <p className="answer-text">{result.answer}</p>
          <p className="answer-meta hint">
            No supporting sources found in the selected corpus.
          </p>
        </div>
      </div>
    );
  }

  if (!result) return null;

  return (
    <div className="search-results" aria-live="polite">
      <div className="answer-card">
        <div className="answer-text">{result.answer}</div>

        {result.citations.length > 0 && (
          <div className="citations-section">
            <h3 className="citations-heading">Sources</h3>
            <ul className="citations-list">
              {result.citations.map((citation, i) => (
                <li key={i} className="citation-item">
                  <blockquote className="citation-quote">
                    &ldquo;{citation.quote}&rdquo;
                  </blockquote>
                  <div className="citation-source">
                    <span className="source-title">{citation.sourceTitle}</span>
                    <span className="source-meta">
                      {citation.edition}
                      {citation.language ? ` · ${citation.language.toUpperCase()}` : ""}
                      {citation.page != null ? ` · p. ${citation.page}` : ""}
                      {citation.section ? ` · ${citation.section}` : ""}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="answer-meta">
          <span className="hint">
            {result.retrievedChunks} chunk{result.retrievedChunks !== 1 ? "s" : ""} retrieved
            {result.meta.retrievalHasMore ? " (more available)" : ""}
          </span>
        </div>
      </div>
    </div>
  );
}
