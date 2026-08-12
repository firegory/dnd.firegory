"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { jobStatusLabel, useUiLanguage } from "../../../components/ui/i18n";

type JobRecord = {
  id: string;
  kind: string;
  status: string;
  sourceId: string | null;
  fileId: string | null;
  progress: number;
  errorSummary: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

const STATUS_STYLES: Record<string, string> = {
  queued: "bg-surface-light text-text-muted",
  processing: "bg-warning/15 text-warning",
  succeeded: "bg-status-success/15 text-status-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-surface-light text-text-muted",
};

const REFRESH_INTERVAL_MS = 10_000;

export function JobsTable() {
  const { language: uiLanguage, t } = useUiLanguage();
  const [jobs, setJobs] = useState<JobRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionStatus, setActionStatus] = useState<Record<string, string>>({});
  const router = useRouter();

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/ingestion/jobs?limit=50");
      if (res.status === 401) {
        router.push("/login");
        return;
      }
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? t("failedToLoadJobs"));
        return;
      }
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("networkError"));
    } finally {
      setLoading(false);
    }
  }, [router, t]);

  useEffect(() => {
    let cancelled = false;
    const loadSoon = setTimeout(() => {
      if (!cancelled) void load();
    }, 0);
    const interval = setInterval(() => {
      if (!cancelled) void load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearTimeout(loadSoon);
      clearInterval(interval);
    };
  }, [load]);

  async function handleRetry(jobId: string) {
    if (!confirm(t("retryConfirm"))) return;
    setActionStatus((prev) => ({ ...prev, [jobId]: "retrying" }));
    try {
      const res = await fetch(`/api/admin/ingestion/jobs/${jobId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? t("retryFailed"));
        return;
      }
      setActionStatus((prev) => ({ ...prev, [jobId]: "retry-ok" }));
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("networkError"));
    } finally {
      clearAction(jobId);
    }
  }

  async function handleReprocess(sourceId: string, jobId: string) {
    if (!confirm(t("reprocessConfirm"))) return;
    setActionStatus((prev) => ({ ...prev, [jobId]: "reprocessing" }));
    try {
      const res = await fetch(`/api/admin/ingestion/sources/${sourceId}/reprocess`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? t("reprocessFailed"));
        return;
      }
      setActionStatus((prev) => ({ ...prev, [jobId]: "reprocess-ok" }));
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : t("networkError"));
    } finally {
      clearAction(jobId);
    }
  }

  function clearAction(jobId: string) {
    setTimeout(() => {
      setActionStatus((prev) => {
        const next = { ...prev };
        delete next[jobId];
        return next;
      });
    }, 3000);
  }

  if (loading) {
    return <p className="text-text-muted">{t("loadingJobs")}</p>;
  }

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  if (jobs.length === 0) {
    return <p className="text-text-muted">{t("noJobs")}</p>;
  }

  return (
    <div className="table-scroll rounded-xl border border-border" role="region" aria-labelledby="processing-jobs-title" tabIndex={0}>
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface">
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("source")}</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("status")}</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("progress")}</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("type")}</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("date")}</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("error")}</th>
            <th className="print-action px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">{t("actions")}</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id} className="border-b border-border-light transition-colors hover:bg-surface-light/50">
              <td className="px-4 py-3">
                {job.sourceId ? (
                  <Link href={`/admin/sources/${job.sourceId}`} className="font-mono text-xs text-accent hover:underline">
                    {job.sourceId.slice(0, 8)}
                  </Link>
                ) : (
                  <span className="text-text-muted">—</span>
                )}
                <p className="mt-1 font-mono text-[10px] text-text-muted">{t("job")} {job.id.slice(0, 8)}</p>
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[job.status] ?? "bg-surface-light text-text-muted"}`}>
                  {jobStatusLabel(job.status, uiLanguage)}
                </span>
              </td>
              <td className="px-4 py-3">
                <div className="min-w-28">
                  <div className="h-1.5 overflow-hidden rounded-full bg-primary">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} />
                  </div>
                  <p className="mt-1 font-mono text-xs text-text-muted">{job.progress}%</p>
                </div>
              </td>
              <td className="px-4 py-3 text-xs text-text-muted">{job.kind}</td>
              <td className="px-4 py-3 text-xs whitespace-nowrap text-text-muted">{formatTimestamp(job.queuedAt)}</td>
              <td className="max-w-56 px-4 py-3 text-xs text-danger">{job.errorSummary ?? "—"}</td>
              <td className="print-action px-4 py-3">
                <Actions
                  job={job}
                  actionStatus={actionStatus}
                  t={t}
                  onRetry={handleRetry}
                  onReprocess={handleReprocess}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Actions({
  job,
  actionStatus,
  t,
  onRetry,
  onReprocess,
}: {
  job: JobRecord;
  actionStatus: Record<string, string>;
  t: ReturnType<typeof useUiLanguage>["t"];
  onRetry: (jobId: string) => void;
  onReprocess: (sourceId: string, jobId: string) => void;
}) {
  const status = actionStatus[job.id];

  if (status === "retrying" || status === "reprocessing") {
    return <span className="text-xs text-text-muted">{formatActionStatus(status, t)}…</span>;
  }

  if (status === "retry-ok") return <span className="text-xs font-semibold text-status-success">{t("retried")}</span>;
  if (status === "reprocess-ok") return <span className="text-xs font-semibold text-status-success">{t("reprocessingDone")}</span>;

  const canRetry = (job.status === "failed" || job.status === "cancelled") && job.sourceId && job.fileId;
  const canReprocess = (job.status === "succeeded" || job.status === "failed") && job.sourceId;

  return (
    <div className="flex gap-1.5">
      {canRetry && <button className="rounded-md border border-warning/40 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/10" onClick={() => onRetry(job.id)}>{t("retry")}</button>}
      {canReprocess && <button className="rounded-md border border-accent/40 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10" onClick={() => onReprocess(job.sourceId!, job.id)}>{t("reprocess")}</button>}
    </div>
  );
}

function formatActionStatus(status: string, t: ReturnType<typeof useUiLanguage>["t"]) {
  if (status === "retrying") return t("retrying");
  if (status === "reprocessing") return t("reprocessing");
  return status;
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
