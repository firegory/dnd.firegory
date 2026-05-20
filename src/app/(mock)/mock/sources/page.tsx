import Link from "next/link";
import { ACCESS_TIER_LABELS, MOCK_SOURCES, SOURCE_SCOPE_LABELS } from "../../../../components/mock/data";

export default function MockSourcesPage() {
  return (
    <div className="space-y-8">
      <nav className="flex items-center gap-2 text-sm text-text-muted">
        <Link href="/mock/search" className="hover:text-accent">
          Поиск
        </Link>
        <span>/</span>
        <span className="text-text-secondary">Источники</span>
      </nav>

      <section className="rounded-2xl border border-border bg-surface p-6">
        <p className="mb-2 text-sm font-semibold tracking-widest text-accent uppercase">
          Source library
        </p>
        <h1 className="mb-2 text-2xl font-bold text-text-primary">
          Источники
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-text-muted">
          Сначала общий каталог всех загруженных источников. Карточка показывает
          тип, язык и количество чанков; клик открывает детальную страницу с
          просмотром и mock-редактированием метаданных.
        </p>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {MOCK_SOURCES.map((source) => (
          <Link
            key={source.id}
            href={`/mock/source/${source.id}`}
            className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/40 hover:bg-surface-light"
          >
            <div className="mb-4 flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-text-primary group-hover:text-accent">
                  {source.title}
                </h2>
                <p className="mt-1 text-xs text-text-muted">
                  Добавлен {source.createdAt}
                </p>
              </div>
              <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                {source.edition}
              </span>
            </div>

            <div className="mb-5 flex flex-wrap gap-2">
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                {SOURCE_SCOPE_LABELS[source.category]}
              </span>
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                {source.language === "ru" ? "Русский" : "English"}
              </span>
              <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-secondary">
                {ACCESS_TIER_LABELS[source.accessTier]}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 border-t border-border pt-4">
              <div>
                <p className="text-xs text-text-muted">Чанков</p>
                <p className="font-mono text-xl font-bold text-accent">
                  {source.totalChunks.toLocaleString()}
                </p>
              </div>
              <div>
                <p className="text-xs text-text-muted">Качество</p>
                <p className="font-mono text-xl font-bold text-text-primary">
                  {source.qualityScore}
                </p>
              </div>
            </div>
          </Link>
        ))}
      </section>
    </div>
  );
}
