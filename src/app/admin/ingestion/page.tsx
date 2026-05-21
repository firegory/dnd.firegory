import Link from "next/link";

import { requireAdmin } from "../../../server/auth/session";
import { AppLayout } from "../../../components/ui/app-layout";
import { T } from "../../../components/ui/i18n";
import { UploadForm } from "./upload-form";
import { JobsTable } from "./jobs-table";

export default async function AdminIngestionPage() {
  await requireAdmin();

  return (
    <AppLayout userRole="admin">
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent"><T k="search" /></Link>
          <span>/</span>
          <span className="text-text-secondary"><T k="adminUploadBreadcrumb" /></span>
        </nav>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="mb-5 flex items-center gap-3">
            <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
              <T k="admin" />
            </span>
            <h1 className="text-2xl font-bold text-text-primary"><T k="uploadPdf" /></h1>
          </div>
          <UploadForm />
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-bold text-text-primary"><T k="processingJobs" /></h2>
            <span className="text-sm text-text-muted"><T k="refreshesEvery10Sec" /></span>
          </div>
          <JobsTable />
        </section>
      </div>
    </AppLayout>
  );
}
