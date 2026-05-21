import Link from "next/link";

import { AppLayout } from "../../../components/ui/app-layout";
import { requireAdmin } from "../../../server/auth/session";
import { listSourcesWithStats } from "../../../server/admin/source-view";

const SOURCE_SCOPE_LABELS: Record<string, string> = {
  core_rules: "Core rules",
  official_supplement: "Supplements",
  homebrew: "Homebrew",
};

const ACCESS_TIER_LABELS: Record<string, string> = {
  open: "Open",
  premium: "Premium",
  personal: "Personal",
};

export default async function SourcesPage() {
  const user = await requireAdmin();
  const sources = await listSourcesWithStats({ userId: user.id, role: "admin" });

  return (
    <AppLayout userRole="admin">
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent">Поиск</Link>
          <span>/</span>
          <span className="text-text-secondary">Источники</span>
        </nav>


        {sources.length === 0 ? (
          <section className="rounded-xl border border-border bg-surface p-6 text-text-muted">
            Источники пока не загружены. Перейдите в <Link href="/admin/ingestion" className="text-accent hover:underline">загрузку PDF</Link>.
          </section>
        ) : (
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {sources.map((source) => (
              <Link
                key={source.id}
                href={`/admin/sources/${source.id}`}
                className="group rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/40 hover:bg-surface-light"
              >
                <div className="mb-4 flex items-start justify-between gap-3">
                  <div>
                    <h2 className="font-semibold text-text-primary group-hover:text-accent">
                      {source.title}
                    </h2>
                    <p className="mt-1 text-xs text-text-muted">
                      Добавлен {formatDate(source.createdAt)}
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
                    <p className="text-xs text-text-muted">Файлов</p>
                    <p className="font-mono text-xl font-bold text-text-primary">
                      {source.totalFiles.toLocaleString()}
                    </p>
                  </div>
                </div>
              </Link>
            ))}
          </section>
        )}
      </div>
    </AppLayout>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
