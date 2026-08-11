"use client";

import { useId, useState, type FormEvent } from "react";

import type { CompendiumEntryScope } from "../../server/retrieval/entity";

type Citation = Readonly<{
  quote: string;
  sourceTitle: string;
  chunkId: string;
  page: number | null;
  section: string | null;
  entityEvidence?: readonly Readonly<{ fieldPath: string | null; citationKind: "field" | "block" }>[];
}>;

type AnswerResponse = Readonly<{
  answer: string;
  claims: readonly Readonly<{ text: string; citations: readonly Citation[] }>[];
  citations: readonly Citation[];
  confident: boolean;
  fallbackReason: string | null;
}>;

type ExactEntryScope = CompendiumEntryScope & Readonly<{
  sourceId: string;
  versionId: string;
  edition: "5e" | "5.5e";
  language: "en" | "ru";
}>;

export function AskAboutEntry({
  title,
  locale,
  scope,
}: Readonly<{ title: string; locale: "en" | "ru"; scope: ExactEntryScope }>) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnswerResponse | null>(null);
  const copy = locale === "ru" ? RU_COPY : EN_COPY;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = query.trim();
    if (!question || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: question, answerLanguage: locale, entryScope: scope }),
      });
      const data = await response.json() as AnswerResponse & { error?: string };
      if (!response.ok) throw new Error(data.error ?? copy.error);
      setResult(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : copy.error);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="entry-question" aria-labelledby={`${inputId}-heading`} aria-busy={loading}>
      <h2 id={`${inputId}-heading`}>{copy.heading}</h2>
      <p>{copy.description.replace("{title}", title)}</p>
      <form onSubmit={submit}>
        <label htmlFor={inputId}>{copy.label}</label>
        <div>
          <input
            id={inputId}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            maxLength={500}
            required
            disabled={loading}
          />
          <button type="submit" disabled={loading || !query.trim()}>{loading ? copy.loading : copy.submit}</button>
        </div>
      </form>
      <div className="entry-question-status" aria-live="polite">
        {error ? <p role="alert">{error}</p> : null}
        {result ? <div>
          {result.claims.length
            ? result.claims.map((claim, index) => <p key={`${claim.text}-${index}`}>{claim.text}{" "}{claim.citations.map((citation) => {
                const citationIndex = result.citations.findIndex((candidate) => candidate.chunkId === citation.chunkId && candidate.quote === citation.quote);
                return citationIndex >= 0
                  ? <sup key={`${citation.chunkId}-${citationIndex}`}><a href={`#entry-answer-citation-${citationIndex + 1}`}>[{citationIndex + 1}]</a></sup>
                  : null;
              })}</p>)
            : <p>{result.answer}</p>}
          {result.citations.length ? <details>
            <summary>{copy.citations.replace("{count}", String(result.citations.length))}</summary>
            <ul>{result.citations.map((citation, index) => <li id={`entry-answer-citation-${index + 1}`} key={`${citation.sourceTitle}-${index}`}>
              <blockquote>«{citation.quote}»</blockquote>
              <span>{citation.sourceTitle}{citation.page === null ? "" : ` · ${copy.page} ${citation.page}`}{citation.section ? ` · ${citation.section}` : ""}</span>
              {citation.entityEvidence?.map((evidence, evidenceIndex) => evidence.fieldPath
                ? <code key={`${evidence.fieldPath}-${evidenceIndex}`}>{evidence.fieldPath}</code>
                : null)}
            </li>)}</ul>
          </details> : null}
        </div> : null}
      </div>
    </section>
  );
}

const EN_COPY = {
  heading: "Ask about this entry",
  description: "Answers are limited to cited source evidence for {title}.",
  label: "Question",
  submit: "Ask",
  loading: "Checking sources...",
  error: "The answer could not be loaded.",
  citations: "Source citations ({count})",
  page: "p.",
} as const;

const RU_COPY = {
  heading: "Спросить об этой записи",
  description: "Ответы ограничены цитируемыми источниками для {title}.",
  label: "Вопрос",
  submit: "Спросить",
  loading: "Проверяем источники...",
  error: "Не удалось загрузить ответ.",
  citations: "Цитаты из источников ({count})",
  page: "стр.",
} as const;
