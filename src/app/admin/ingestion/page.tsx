import Link from "next/link";

import { requireAdmin } from "../../../server/auth/session";
import { AppLayout } from "../../../components/ui/app-layout";
import { UploadForm } from "./upload-form";
import { JobsTable } from "./jobs-table";

export default async function AdminIngestionPage() {
  await requireAdmin();

  return (
    <AppLayout userRole="admin">
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent">Поиск</Link>
          <span>/</span>
          <span className="text-text-secondary">Админ · Загрузка</span>
        </nav>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
              Admin
            </span>
            <h1 className="text-2xl font-bold text-text-primary">Загрузка PDF</h1>
          </div>
          <UploadForm />
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-bold text-text-primary">Задачи обработки</h2>
            <span className="text-sm text-text-muted">Обновляется каждые 10 сек</span>
          </div>
          <JobsTable />
        </section>
      </div>
    </AppLayout>
  );
}
