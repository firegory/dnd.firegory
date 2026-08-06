"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AppSelect } from "../../components/ui/select";
import { categoryLabel, useUiLanguage } from "../../components/ui/i18n";

const STORAGE_KEYS = {
  edition: "dnd.firegory.search.edition",
  sourceLanguage: "dnd.firegory.search.sourceLanguage",
  category: "dnd.firegory.search.category",
} as const;

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
  chunkId: string;
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

function usePersistentState(key: string, initialValue: string) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    const stored = window.localStorage.getItem(key);
    if (stored !== null) queueMicrotask(() => setValue(stored));
  }, [key]);

  useEffect(() => {
    window.localStorage.setItem(key, value);
  }, [key, value]);

  return [value, setValue] as const;
}

export function SearchForm() {
  const { language: uiLanguage, t } = useUiLanguage();
  const [query, setQuery] = useState("");
  const [edition, setEdition] = usePersistentState(STORAGE_KEYS.edition, "");
  const [sourceLanguage, setSourceLanguage] = usePersistentState(STORAGE_KEYS.sourceLanguage, "");
  const [category, setCategory] = usePersistentState(STORAGE_KEYS.category, "");
  const [status, setStatus] = useState<FetchStatus>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);

  const scopeOptions = [
    { value: "", label: t("allSources"), description: t("allSourcesDescription") },
    { value: "core_rules", label: t("coreRules"), description: t("coreRulesDescription") },
    { value: "official_supplement", label: t("supplements"), description: t("supplementsDescription") },
    { value: "homebrew", label: t("homebrew"), description: t("homebrewDescription") },
  ] as const;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setStatus("loading");
    setErrorMessage(null);
    setResult(null);

    try {
      const body: Record<string, unknown> = {
        query: query.trim(),
        answerLanguage: uiLanguage,
        ...(edition ? { edition } : {}),
        ...(sourceLanguage ? { language: sourceLanguage } : {}),
      };
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
          setErrorMessage(t("sessionExpired"));
          return;
        }
        if (response.status === 503) {
          setStatus("not-configured");
          setErrorMessage(data.error ?? t("answerUnavailable"));
          return;
        }
        setStatus("error");
        setErrorMessage(data.error ?? t("requestFailed"));
        return;
      }

      setResult(data as SearchResult);
      setStatus("success");
    } catch (err) {
      setStatus("error");
      setErrorMessage(err instanceof Error ? err.message : t("networkError"));
    }
  }

  const loading = status === "loading";

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-border bg-surface p-6">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="flex flex-col gap-3 lg:flex-row">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              maxLength={500}
              required
              disabled={loading}
              autoFocus
              className="flex-1 rounded-xl border border-border bg-primary/60 px-5 py-3 text-text-primary placeholder-text-muted outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20 disabled:cursor-wait disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!query.trim() || loading}
              className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {loading ? t("searchingButton") : t("searchButton")}
            </button>
          </div>

          <div className="flex flex-wrap items-end gap-4">
            <AppSelect
              label={t("edition")}
              value={edition}
              options={[
                { value: "", label: t("allEditions"), description: t("allEditionsDescription") },
                { value: "5e", label: "5e" },
                { value: "5.5e", label: "5.5e" },
              ]}
              onChange={setEdition}
              disabled={loading}
            />
            <AppSelect
              label={t("sourceLanguage")}
              value={sourceLanguage}
              options={[
                { value: "", label: t("allLanguages"), description: t("allLanguagesDescription") },
                { value: "ru", label: "RU" },
                { value: "en", label: "EN" },
              ]}
              onChange={setSourceLanguage}
              disabled={loading}
            />
            <AppSelect
              label={t("scope")}
              value={category}
              options={scopeOptions}
              onChange={setCategory}
              disabled={loading}
            />
          </div>
        </form>
      </section>

      {loading && (
        <div className="flex items-center justify-center gap-3 py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-text-muted">{t("searchingSources")}</span>
        </div>
      )}

      {status === "error" && errorMessage && (
        <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-danger">
          {errorMessage}
        </div>
      )}

      {status === "not-configured" && errorMessage && (
        <div className="rounded-xl border border-warning/30 bg-warning/10 p-4 text-warning">
          <p>{errorMessage}</p>
          <p className="mt-1 text-sm text-text-muted">
            {t("answerProviderRequired")}
          </p>
        </div>
      )}

      {status === "success" && result && <SearchResultView result={result} />}
    </div>
  );
}

function SearchResultView({ result }: { result: SearchResult }) {
  const { t } = useUiLanguage();
  const [previewCitation, setPreviewCitation] = useState<Citation | null>(null);

  return (
    <div className="space-y-8">
      <section className="rounded-2xl border border-accent/30 bg-accent/5 p-6">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
            {t("aiAnswer")}
          </span>
          <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-text-muted">
            {t("basedOnCitations", { count: result.citations.length })}
          </span>
          {!result.confident && (
            <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-semibold text-warning">
              {t("lowConfidence")}
            </span>
          )}
        </div>
        <p className="whitespace-pre-wrap leading-relaxed text-text-primary">
          {result.answer}
        </p>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-bold text-text-primary">{t("sourceCitations")}</h2>
          <span className="text-sm text-text-muted">
            {t("foundChunks", { count: result.meta.retrievalTotal ?? result.retrievedChunks })}
          </span>
        </div>
        {result.citations.length === 0 ? (
          <div className="rounded-xl border border-border bg-surface p-5 text-text-muted">
            {t("noCitations")}
          </div>
        ) : (
          <div className="space-y-4">
            {result.citations.map((citation, i) => (
              <CitationCard
                key={`${citation.sourceId}-${citation.fileId}-${citation.page}-${i}`}
                citation={citation}
                onPreview={setPreviewCitation}
              />
            ))}
          </div>
        )}
      </section>

      {previewCitation && (
        <CitationPreviewModal citation={previewCitation} onClose={() => setPreviewCitation(null)} />
      )}
    </div>
  );
}

function CitationCard({ citation, onPreview }: { citation: Citation; onPreview: (citation: Citation) => void }) {
  const { language: uiLanguage, t } = useUiLanguage();
  const canPreview = Boolean(citation.sourceId && citation.fileId && citation.page !== null);

  return (
    <article className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/30">
      <button
        type="button"
        disabled={!canPreview}
        onClick={() => canPreview && onPreview(citation)}
        className="print-content mb-4 block w-full border-l-3 border-accent pl-4 text-left text-sm leading-relaxed text-text-secondary italic transition-colors enabled:hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-70"
        title={canPreview ? t("openCitationPreview") : t("citationPreviewUnavailable")}
      >
        «{citation.quote}»
      </button>

      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/admin/sources/${citation.sourceId}`}
          className="font-semibold text-accent hover:underline"
        >
          {citation.sourceTitle}
        </Link>
        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
          {citation.edition}
        </span>
        <span className="rounded-full bg-surface-light px-2 py-0.5 text-xs font-medium text-text-muted">
          {citation.language.toUpperCase()}
        </span>
        {citation.page !== null && <span className="text-xs text-text-muted">{t("pageShort")} {citation.page}</span>}
        {citation.category && (
          <span className="rounded-full bg-surface-light px-2 py-0.5 text-xs font-medium text-text-muted">
            {categoryLabel(citation.category, uiLanguage)}
          </span>
        )}
        {citation.section && (
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
            {citation.section}
          </span>
        )}
        {canPreview && (
          <button
            type="button"
            onClick={() => onPreview(citation)}
            className="rounded-full border border-accent/40 px-2 py-0.5 text-xs font-medium text-accent transition-colors hover:bg-accent/10"
          >
            {t("citationPreview")}
          </button>
        )}
      </div>
    </article>
  );
}

function CitationPreviewModal({ citation, onClose }: { citation: Citation; onClose: () => void }) {
  const { t } = useUiLanguage();
  const [showFullPage, setShowFullPage] = useState(false);
  const [imgError, setImgError] = useState(false);

  const hasChunkId = Boolean(citation.chunkId);
  const croppedUrl = hasChunkId
    ? `/api/citations/preview?chunkId=${encodeURIComponent(citation.chunkId)}`
    : null;
  const fullPageUrl = `/api/citations/preview?sourceId=${encodeURIComponent(citation.sourceId)}&fileId=${encodeURIComponent(citation.fileId)}&page=${citation.page}`;
  const wantsFullPage = showFullPage || !croppedUrl || imgError;
  const previewUrl = wantsFullPage ? fullPageUrl : croppedUrl;

  const handleToggle = useCallback(() => {
    setShowFullPage((v) => !v);
    setImgError(false);
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-label={t("citationPreview")}>
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-border p-4">
          <div>
            <h3 className="font-semibold text-text-primary">{citation.sourceTitle}</h3>
            <p className="text-sm text-text-muted">
              {citation.page !== null ? `${t("pageShort")} ${citation.page}` : t("pageUnknown")}
              {citation.section ? ` · ${citation.section}` : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1 text-sm text-text-secondary hover:bg-surface-light"
          >
            {t("close")}
          </button>
        </div>
        <div className="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-h-0 overflow-auto bg-primary/70 p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={previewUrl}
              alt={t("renderedPdfPage", { page: citation.page ?? "" })}
              className="mx-auto max-h-none w-full max-w-4xl rounded-lg border border-border bg-white object-contain"
              onError={() => {
                if (!imgError && previewUrl !== fullPageUrl) {
                  setImgError(true);
                }
              }}
            />
          </div>
          <aside className="space-y-4 overflow-auto border-t border-border p-4 lg:border-l lg:border-t-0">
            {!hasChunkId && (
              <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                {t("pageLevelPreviewNotice")}
              </div>
            )}
            {hasChunkId && !imgError && (
              <button
                type="button"
                onClick={handleToggle}
                className="w-full rounded-xl border border-accent/40 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/10"
              >
                {showFullPage ? t("showCroppedPreview") : t("showFullPage")}
              </button>
            )}
            {imgError && (
              <div className="rounded-xl border border-warning/30 bg-warning/10 p-3 text-sm text-warning">
                {t("croppedPreviewFailed")}
              </div>
            )}
            <div>
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-muted">{t("quoteContext")}</div>
              <blockquote className="border-l-3 border-accent pl-3 text-sm leading-relaxed text-text-secondary italic">
                «{citation.quote}»
              </blockquote>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
