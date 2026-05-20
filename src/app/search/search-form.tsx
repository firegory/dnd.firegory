"use client";

import { useState, type FormEvent } from "react";

const EDITIONS = [
  { value: "", label: "Any edition" },
  { value: "5e", label: "D&D 5e" },
  { value: "5.5e", label: "D&D 5.5e" },
] as const;

const LANGUAGES = [
  { value: "", label: "Any language" },
  { value: "en", label: "English" },
  { value: "ru", label: "Russian" },
] as const;

const ANSWER_LANGUAGES = [
  { value: "en", label: "English" },
  { value: "ru", label: "Русский" },
] as const;

const CATEGORIES = [
  { value: "", label: "All categories" },
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
  fileId: string;
  sourceId: string;
}>;

type SearchResult = Readonly<{
  answer: string;
  citations: readonly Citation[];
  confident: boolean;
  retrievedChunks: number;
  meta: {
    model?: string;
    retrievalTotal?: number;
    retrievalHasMore?: boolean;
    usage?: unknown;
  };
}>;

type FetchStatus = "idle" | "loading" | "success" | "error" | "not-configured";

export function SearchForm() {
  const [query, setQuery] = useState("");
  const [edition, setEdition] = useState("");
  const [language, setLanguage] = useState("");
  const [answerLanguage, setAnswerLanguage] = useState<string>("en");
  const [category, setCategory] = useState("");
  const [status, setStatus] = useState<FetchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setStatus("loading");
    setErrorMessage(null);
    setResult(null);

    try {
      const body: Record<string, unknown> = {
        query: query.trim(),
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
        if (response.status === 401) {
          setStatus("error");
          setErrorMessage("Session expired. Please sign in again.");
          return;
        }
        if (response.status === 503) {
          setStatus("not-configured");
          setErrorMessage(data.error ?? "Answer generation is not available.");
          return;
        }
        setStatus("error");
        setErrorMessage(data.error ?? "Request failed.");
        return;
      }

      setResult(data as SearchResult);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : "Network error.");
    }
  }

  return (
    <div className="search-container">
      <form onSubmit={handleSubmit} className="search-form">
        <div className="search-input-row">
          <input
            type="text"
            className="search-query-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask about D&D rules…"
            maxLength={500}
            required
            disabled={status === "loading"}
            autoFocus
          />
          <button
            type="submit"
            className="search-submit-btn"
            disabled={!query.trim() || status === "loading"}
          >
            {status === "loading" ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="search-toggles">
          <label className="search-toggle-label">
            Answer in
            <select
              value={answerLanguage}
              onChange={(e) => setAnswerLanguage(e.target.value)}
              disabled={status === "loading"}
            >
              {ANSWER_LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>

          <label className="search-toggle-label">
            Edition
            <select
              value={edition}
              onChange={(e) => setEdition(e.target.value)}
              disabled={status === "loading"}
            >
              {EDITIONS.map((ed) => (
                <option key={ed.value} value={ed.value}>{ed.label}</option>
              ))}
            </select>
          </label>

          <label className="search-toggle-label">
            Source lang
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              disabled={status === "loading"}
            >
              {LANGUAGES.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </label>

          <label className="search-toggle-label">
            Category
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={status === "loading"}
            >
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>{c.label}</option>
              ))}
            </select>
          </label>
        </div>
      </form>

      {status === "error" && errorMessage && (
        <div className="search-error">
          <p className="form-error">{errorMessage}</p>
        </div>
      )}

      {status === "not-configured" && errorMessage && (
        <div className="search-error">
          <p className="form-error">{errorMessage}</p>
          <p className="hint">
            Answer generation requires a configured LLM provider. Contact your admin.
          </p>
        </div>
      )}

      {status === "success" && result && (
        <SearchResultView result={result} />
      )}
    </div>
  );
}

function SearchResultView({ result }: { result: SearchResult }) {
  return (
    <div className="search-result">
      <div className="search-answer">
        <h2>Answer</h2>
        <p className={result.confident ? "answer-text" : "answer-text answer-low-confidence"}>
          {result.answer}
        </p>
        {!result.confident && (
          <p className="hint confidence-hint">
            ⚠ The system could not find a definitive answer in the available sources.
          </p>
        )}
      </div>

      {result.citations.length > 0 && (
        <div className="search-citations">
          <h3>Sources ({result.citations.length})</h3>
          <ul className="citations-list">
            {result.citations.map((citation, i) => (
              <li key={i} className="citation-item">
                <blockquote className="citation-quote">
                  &ldquo;{citation.quote}&rdquo;
                </blockquote>
                <div className="citation-meta">
                  <span className="citation-title">{citation.sourceTitle}</span>
                  {citation.edition && (
                    <span className="citation-tag">{citation.edition}</span>
                  )}
                  {citation.language && (
                    <span className="citation-tag">{citation.language.toUpperCase()}</span>
                  )}
                  {citation.page !== null && (
                    <span className="citation-tag">p.{citation.page}</span>
                  )}
                  {citation.section && (
                    <span className="citation-tag citation-section">{citation.section}</span>
                  )}
                  {citation.category && (
                    <span className="citation-tag">{formatCategory(citation.category)}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="hint search-meta">
        Retrieved {result.meta.retrievalTotal ?? result.retrievedChunks} chunk{result.meta.retrievalTotal !== 1 ? "s" : ""}
        {result.meta.retrievalHasMore ? " (more available)" : ""}
        {result.meta.model && result.meta.model !== "none" ? ` · Model: ${result.meta.model}` : ""}
      </p>
    </div>
  );
}

function formatCategory(category: string): string {
  const map: Record<string, string> = {
    core_rules: "Core Rules",
    official_supplement: "Supplement",
    homebrew: "Homebrew",
  };
  return map[category] ?? category;
}
