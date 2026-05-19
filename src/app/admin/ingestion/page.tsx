import Link from "next/link";

import { requireAdmin } from "../../../server/auth/session";
import { UploadForm } from "./upload-form";
import { JobsTable } from "./jobs-table";

export default async function AdminIngestionPage() {
  await requireAdmin();

  return (
    <main className="page-shell wide-page">
      <section className="hero-card" aria-labelledby="ingestion-title">
        <p className="eyebrow">Admin</p>
        <h1 id="ingestion-title">Ingestion</h1>
        <p className="lede">Upload PDFs and monitor ingestion jobs.</p>

        <h2>Upload PDF</h2>
        <UploadForm />

        <h2 style={{ marginTop: "2.5rem" }}>Job status</h2>
        <JobsTable />

        <p className="muted" style={{ marginTop: "1.5rem" }}>
          <Link href="/">Back to app</Link>
          {" · "}
          <Link href="/admin/users">Manage users</Link>
        </p>
      </section>
    </main>
  );
}
