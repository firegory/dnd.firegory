import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AppLayout } from "../../../../components/ui/app-layout";
import { AccessTierLabel, CategoryLabel, JobStatusLabel, SourceLanguageLabel } from "../../../../components/ui/localized-labels";
import { T } from "../../../../components/ui/i18n";
import { requireAdmin } from "../../../../server/auth/session";
import { ContentMetadataNotFoundError } from "../../../../server/content/metadata";
import { getSourceWithStats, listSourceChunkPreviews } from "../../../../server/admin/source-view";
import { SourceMetadataEditor } from "./source-metadata-editor";

const STATUS_STYLES: Record<string, string> = {
  queued: "text-text-muted",
  processing: "text-warning",
  succeeded: "text-success",
  failed: "text-danger",
  cancelled: "text-text-muted",
};

type PageProps = { params: Promise<{ sourceId: string }> };

export default async function SourceDetailPage({ params }: PageProps) {
  const { sourceId } = await params;
  const user = await requireAdmin();

  let source;
  try {
    source = await getSourceWithStats({ userId: user.id, role: "admin" }, sourceId);
  } catch (error) {
    if (error instanceof ContentMetadataNotFoundError) notFound();
    throw error;
  }

  const chunks = await listSourceChunkPreviews(source.id);

  return (
    <AppLayout userRole="admin" wide>
      <div className="space-y-8">
        <nav className="flex items-center gap-2 text-sm text-text-muted">
          <Link href="/search" className="hover:text-accent"><T k="search" /></Link>
          <span>/</span>
          <Link href="/admin/sources" className="hover:text-accent"><T k="sources" /></Link>
          <span>/</span>
          <span className="text-text-secondary"><T k="sourceDetails" /></span>
        </nav>

        <section className="rounded-2xl border border-border bg-surface p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {source.edition}
                </span>
                <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  <SourceLanguageLabel value={source.language} />
                </span>
                <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  <CategoryLabel value={source.category} />
                </span>
                <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  <AccessTierLabel value={source.accessTier} />
                </span>
              </div>
              <h1 className="text-2xl font-bold text-text-primary">{source.title}</h1>
              <p className="mt-1 text-sm text-text-muted"><T k="added" /> {formatDate(source.createdAt)}</p>
            </div>

            <div className="flex items-center gap-3 rounded-xl border border-border bg-primary/60 px-5 py-3">
              <div className="text-center">
                <p className="text-3xl font-bold text-accent">{source.totalChunks}</p>
                <p className="text-[10px] tracking-wider text-text-muted uppercase"><T k="chunks" /></p>
              </div>
              <div className="text-sm">
                <p className={`font-semibold ${source.latestJobStatus ? STATUS_STYLES[source.latestJobStatus] : "text-text-muted"}`}>
                  <JobStatusLabel value={source.latestJobStatus ?? ""} />
                </p>
                <p className="text-xs text-text-muted"><T k="latestProcessing" /></p>
              </div>
            </div>
          </div>
        </section>

        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label={<T k="pages" />} value={source.totalPages.toString()} />
          <StatCard label={<T k="chunks" />} value={source.totalChunks.toLocaleString()} />
          <StatCard label={<T k="embeddings" />} value={`${source.embeddingsGenerated}`} sub={<><T k="skipped" />: {source.embeddingsSkipped}</>} />
          <StatCard label={<T k="files" />} value={source.totalFiles.toString()} />
        </section>

        <SourceMetadataEditor source={source} />

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-3 text-lg font-bold text-text-primary"><T k="latestJob" /></h2>
          <div className="grid gap-3 sm:grid-cols-3">
            <Info label={<T k="jobId" />} value={source.latestJobId ?? "—"} mono />
            <Info label={<T k="started" />} value={source.latestJobStartedAt ? formatDate(source.latestJobStartedAt) : "—"} />
            <Info label={<T k="finished" />} value={source.latestJobFinishedAt ? formatDate(source.latestJobFinishedAt) : "—"} />
          </div>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between gap-4">
            <h2 className="text-xl font-bold text-text-primary"><T k="chunksAndCitations" /></h2>
            <span className="text-sm text-text-muted"><T k="shownChunks" vars={{ shown: chunks.length, total: source.totalChunks }} /></span>
          </div>
          {chunks.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface p-5 text-text-muted">
              <T k="noChunks" />
            </div>
          ) : (
            <div className="space-y-3">
              {chunks.map((chunk) => (
                <div key={chunk.id} className="rounded-xl border border-border bg-surface p-5 transition-colors hover:border-accent/20">
                  <blockquote className="mb-3 border-l-3 border-accent/60 pl-4 text-sm leading-relaxed text-text-secondary italic">
                    «{chunk.quoteText}»
                  </blockquote>
                  <div className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
                    <span className="font-mono">{chunk.id.slice(0, 8)}</span>
                    {chunk.pageNumber && <span><T k="pageShort" /> {chunk.pageNumber}</span>}
                    {chunk.sectionHeading && (
                      <span className="rounded-full bg-accent/10 px-2 py-0.5 text-accent">
                        {chunk.sectionHeading}
                      </span>
                    )}
                    <span className="ml-auto">{chunk.charCount} <T k="chars" /></span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </AppLayout>
  );
}

function StatCard({ label, value, sub }: { label: ReactNode; value: string; sub?: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="text-xs font-semibold tracking-wider text-text-muted uppercase">{label}</p>
      <p className="mt-1 font-mono text-2xl font-bold text-text-primary">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-text-muted">{sub}</p>}
    </div>
  );
}

function Info({ label, value, mono = false }: { label: ReactNode; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</p>
      <p className={`text-sm text-text-secondary ${mono ? "font-mono" : ""}`}>{value}</p>
    </div>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
