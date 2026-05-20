import Link from "next/link";

// ── Hardcoded mock data for source detail ──

const SOURCE = {
  id: "src-1",
  title: "Player's Handbook 2024 (ru)",
  edition: "5.5e",
  language: "ru",
  category: "core_rules" as const,
  accessTier: "open" as const,
  totalPages: 387,
  totalChunks: 2572,
  embeddingsGenerated: 0,
  embeddingsSkipped: 2572,
  qualityScore: 82,
  qualityStatus: "good" as const,
  createdAt: "2026-05-20 14:30",
  lastJob: {
    id: "job-1",
    status: "completed" as const,
    startedAt: "2026-05-20 14:32",
    completedAt: "2026-05-20 14:35",
    duration: "~3 мин",
  },
};

const MOCK_CHUNKS = [
  {
    id: "chunk-1",
    text: "Sneak Attack. Если вы попадаете атакой по существу, и у вас есть преимущество на бросок атаки, или другое дружественное существо находится в пределах 5 футов от цели, вы можете добавить дополнительный урон. Дополнительный урон составляет 1d6 на уровнях 1–2, 2d6 на уровнях 3–4 и так далее.",
    page: 127,
    section: "Класс: Плут — Sneak Attack",
    charCount: 342,
  },
  {
    id: "chunk-2",
    text: "Действия в бою. В свой ход вы можете переместиться на расстояние до вашей скорости и совершить одно действие. Вы можете использовать бонусное действие, если у вас есть способность, позволяющая это. Вы можете использовать одну реакцию между своими ходами.",
    page: 45,
    section: "Бой — Действия в бою",
    charCount: 268,
  },
  {
    id: "chunk-3",
    text: "Заклинание Fireball. 3-й уровень, школа эвокации. Время накладывания: 1 действие. Дальность: 150 футов. Компоненты: V, S, M (маленький шарик из гуано летучей мыши и серы). Выброс: 8d6 урона огнём при провале спасброска Ловести.",
    page: 289,
    section: "Заклинания — Fireball",
    charCount: 315,
  },
  {
    id: "chunk-4",
    text: "Классы. В D&D существует 12 базовых классов: Варвар, Бард, Жрец, Друид, Воин, Монах, Паладин, Следопыт, Плут, Чародей, Колдун и Волшебник. Каждый класс определяет ключевые способности персонажа и его роль в группе приключенцев.",
    page: 52,
    section: "Создание персонажа — Классы",
    charCount: 298,
  },
  {
    id: "chunk-5",
    text: "Доспехи. Лёгкий доспех (кожаный — AC 11 + DEX, проклёпанная кожа — AC 12 + DEX). Средний доспех (шкуры — AC 12 + DEX (макс 2), полулаты — AC 13 + DEX (макс 2)). Тяжёлый доспех (кольчуга — AC 14, латные — AC 17, снижает скорость).",
    page: 168,
    section: "Снаряжение — Доспехи и щиты",
    charCount: 356,
  },
];

const QUALITY_COLORS: Record<string, string> = {
  good: "text-success",
  excellent: "text-accent",
  acceptable: "text-warning",
  poor: "text-danger",
};

const CATEGORY_LABELS: Record<string, string> = {
  core_rules: "Core Rules",
  official_supplement: "Official Supplement",
  homebrew: "Homebrew",
};

export default function MockSourceDetailPage() {
  return (
    <div className="space-y-8">
      {/* Breadcrumbs */}
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock" className="hover:text-accent">
          Главная
        </Link>
        <span>/</span>
        <Link href="/mock/search" className="hover:text-accent">
          Поиск
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Источник</span>
      </nav>

      {/* Header */}
      <section className="rounded-2xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                {SOURCE.edition}
              </span>
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                {SOURCE.language === "ru" ? "Русский" : "English"}
              </span>
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                {CATEGORY_LABELS[SOURCE.category]}
              </span>
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                {SOURCE.accessTier}
              </span>
            </div>
            <h1 className="text-2xl font-bold text-text-primary">
              {SOURCE.title}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              Добавлен {SOURCE.createdAt}
            </p>
          </div>

          {/* Quality badge */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-primary/60 px-5 py-3">
            <div className="text-center">
              <p className="text-3xl font-bold text-accent">
                {SOURCE.qualityScore}
              </p>
              <p className="text-[10px] tracking-wider text-text-muted uppercase">
                Quality
              </p>
            </div>
            <div className="text-sm">
              <p
                className={`font-semibold ${QUALITY_COLORS[SOURCE.qualityStatus]}`}
              >
                Good
              </p>
              <p className="text-xs text-text-muted">Качество обработки</p>
            </div>
          </div>
        </div>
      </section>

      {/* Stats grid */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Страниц" value={SOURCE.totalPages.toString()} />
        <StatCard label="Чанков" value={SOURCE.totalChunks.toLocaleString()} />
        <StatCard
          label="Embeddings"
          value={`${SOURCE.embeddingsGenerated}`}
          sub={`${SOURCE.embeddingsSkipped} skipped`}
        />
        <StatCard
          label="Время обработки"
          value={SOURCE.lastJob.duration}
          sub={SOURCE.lastJob.status === "completed" ? "Завершено" : ""}
        />
      </section>

      {/* Job info */}
      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 text-lg font-bold text-text-primary">
          Последняя задача
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              ID задачи
            </p>
            <p className="font-mono text-sm text-text-secondary">
              {SOURCE.lastJob.id}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              Начало
            </p>
            <p className="text-sm text-text-secondary">
              {SOURCE.lastJob.startedAt}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">
              Завершение
            </p>
            <p className="text-sm text-text-secondary">
              {SOURCE.lastJob.completedAt}
            </p>
          </div>
        </div>
      </section>

      {/* Chunks */}
      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-xl font-bold text-text-primary">
            Чанки и цитаты
          </h2>
          <span className="text-sm text-text-muted">
            Показано {MOCK_CHUNKS.length} из {SOURCE.totalChunks}
          </span>
        </div>
        <div className="space-y-3">
          {MOCK_CHUNKS.map((chunk) => (
            <div
              key={chunk.id}
              className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/20"
            >
              <blockquote className="mb-3 border-l-3 border-accent/60 pl-4 text-sm leading-relaxed text-text-secondary italic">
                «{chunk.text}»
              </blockquote>
              <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                <span className="font-mono">{chunk.id}</span>
                <span>стр. {chunk.page}</span>
                <span className="rounded-full bg-accent/10 px-2 py-0.5 text-accent">
                  {chunk.section}
                </span>
                <span className="ml-auto">{chunk.charCount} символов</span>
              </div>
            </div>
          ))}
        </div>

        {/* Load more */}
        <div className="mt-6 text-center">
          <button className="rounded-xl border border-border bg-surface px-6 py-2.5 text-sm font-medium text-text-secondary transition-colors hover:border-accent/30 hover:text-accent">
            Загрузить ещё ({SOURCE.totalChunks - MOCK_CHUNKS.length} чанков)
          </button>
        </div>
      </section>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-semibold tracking-wider text-text-muted uppercase">
        {label}
      </p>
      <p className="mt-1 font-mono text-2xl font-bold text-text-primary">
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-text-muted">{sub}</p>}
    </div>
  );
}
