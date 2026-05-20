"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";

// ── Hardcoded mock data ──

const MOCK_RESULTS = [
  {
    id: "c1",
    quote:
      "Sneak Attack. Если вы попадаете атакой по существу, и у вас есть преимущество на бросок атаки, или другое дружественное существо находится в пределах 5 футов от цели, вы можете добавить дополнительный урон. Дополнительный урон составляет 1d6 на уровнях 1–2, 2d6 на уровнях 3–4 и так далее.",
    sourceTitle: "Player's Handbook 2024 (ru)",
    sourceId: "src-1",
    edition: "5.5e",
    language: "ru",
    page: 127,
    section: "Класс: Плут — Sneak Attack",
    category: "core_rules",
    relevanceScore: 0.95,
  },
  {
    id: "c2",
    quote:
      "Beginning at 1st level, you know how to strike subtly and exploit a foe's distraction. Once per turn, you can deal an extra 1d6 damage to one creature you hit with an attack if you have advantage on the attack roll.",
    sourceTitle: "Player's Handbook 2024 (en)",
    sourceId: "src-2",
    edition: "5.5e",
    language: "en",
    page: 142,
    section: "Rogue: Sneak Attack",
    category: "core_rules",
    relevanceScore: 0.91,
  },
  {
    id: "c3",
    quote:
      "Вы можете использовать Sneak Attack один раз за ход. Дополнительный урон увеличивается на 1d6 при достижении определённых уровней плута: 3-й (2d6), 5-й (3d6), 7-й (4d6)...",
    sourceTitle: "Player's Handbook 2024 (ru)",
    sourceId: "src-1",
    edition: "5.5e",
    language: "ru",
    page: 128,
    section: "Класс: Плут — Sneak Attack: масштабирование",
    category: "core_rules",
    relevanceScore: 0.87,
  },
];

const MOCK_ANSWER =
  "**Sneak Attack** — ключевевая способность Плута (Rogue) в D&D. Если у вас есть преимущество на бросок атаки или дружественное существо находится рядом с целью, вы можете добавить кубики дополнительного урона (начиная с 1d6 на 1 уровне, увеличиваясь каждые 2 уровня). Можно использовать один раз за ход.";

type ResultStatus = "idle" | "loading" | "done";

export default function MockSearchPage() {
  const [query, setQuery] = useState("");
  const [edition, setEdition] = useState("");
  const [language, setLanguage] = useState("");
  const [status, setStatus] = useState<ResultStatus>("idle");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setStatus("loading");
    setTimeout(() => setStatus("done"), 800);
  }

  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock" className="hover:text-accent">
          Главная
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Поиск</span>
      </nav>

      {/* Search form */}
      <section className="rounded-2xl border border-border bg-surface p-6">
        <h1 className="mb-1 text-2xl font-bold text-text-primary">
          Поиск по правилам
        </h1>
        <p className="mb-6 text-sm text-text-muted">
          Найдите правило с точной цитатой из источника
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Query input */}
          <div className="flex gap-3">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Как работает Sneak Attack?"
              className="flex-1 rounded-xl border border-border bg-primary/60 px-5 py-3 text-text-primary placeholder-text-muted outline-none transition-colors focus:border-accent focus:ring-2 focus:ring-accent/20"
            />
            <button
              type="submit"
              disabled={status === "loading"}
              className="rounded-xl bg-accent px-6 py-3 font-semibold text-primary transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
            >
              {status === "loading" ? "Поиск…" : "Искать"}
            </button>
          </div>

          {/* Filters row */}
          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">
                Редакция
              </span>
              <select
                value={edition}
                onChange={(e) => setEdition(e.target.value)}
                className="rounded-lg border border-border bg-primary/60 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              >
                <option value="">Любая</option>
                <option value="5e">D&D 5e</option>
                <option value="5.5e">D&D 5.5e</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">
                Язык
              </span>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
                className="rounded-lg border border-border bg-primary/60 px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              >
                <option value="">Любой</option>
                <option value="ru">Русский</option>
                <option value="en">English</option>
              </select>
            </label>
          </div>
        </form>
      </section>

      {/* Loading */}
      {status === "loading" && (
        <div className="flex items-center justify-center gap-3 py-12">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-accent border-t-transparent" />
          <span className="text-text-muted">Ищем по источникам…</span>
        </div>
      )}

      {/* Results */}
      {status === "done" && (
        <div className="space-y-8">
          {/* Answer */}
          <section className="rounded-2xl border border-accent/30 bg-accent/5 p-6">
            <div className="mb-3 flex items-center gap-2">
              <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                AI-ответ
              </span>
              <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-text-muted">
                На основе 3 цитат
              </span>
            </div>
            <p className="leading-relaxed text-text-primary">{MOCK_ANSWER}</p>
          </section>

          {/* Citations */}
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-bold text-text-primary">
                Цитаты из источников
              </h2>
              <span className="text-sm text-text-muted">
                Найдено: 3 чанка
              </span>
            </div>
            <div className="space-y-4">
              {MOCK_RESULTS.map((r) => (
                <CitationCard key={r.id} {...r} />
              ))}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function CitationCard({
  quote,
  sourceTitle,
  sourceId,
  edition,
  language,
  page,
  section,
  relevanceScore,
}: (typeof MOCK_RESULTS)[number]) {
  return (
    <div className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/30">
      {/* Quote */}
      <blockquote className="mb-4 border-l-3 border-accent pl-4 text-sm leading-relaxed text-text-secondary italic">
        «{quote}»
      </blockquote>

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={`/mock/source/${sourceId}`}
          className="font-semibold text-accent hover:underline"
        >
          {sourceTitle}
        </Link>
        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-xs font-medium text-accent">
          {edition}
        </span>
        <span className="rounded-full bg-surface-light px-2 py-0.5 text-xs font-medium text-text-muted">
          {language === "ru" ? "RU" : "EN"}
        </span>
        {page && (
          <span className="text-xs text-text-muted">стр. {page}</span>
        )}
        {section && (
          <span className="rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
            {section}
          </span>
        )}
        <span className="ml-auto font-mono text-xs text-text-muted">
          {(relevanceScore * 100).toFixed(0)}% match
        </span>
      </div>
    </div>
  );
}
