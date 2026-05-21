"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

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
  succeeded: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  cancelled: "bg-surface-light text-text-muted",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "В очереди",
  processing: "Обработка",
  succeeded: "Завершён",
  failed: "Ошибка",
  cancelled: "Отменён",
};

const REFRESH_INTERVAL_MS = 10_000;

export function JobsTable() {
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
        setError(data.error ?? "Failed to load jobs.");
        return;
      }
      setJobs(data.jobs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }, [router]);

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
    if (!confirm("Retry this failed job? A new job will be created with the same source and file.")) return;
    setActionStatus((prev) => ({ ...prev, [jobId]: "retrying" }));
    try {
      const res = await fetch(`/api/admin/ingestion/jobs/${jobId}/retry`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Retry failed.");
        return;
      }
      setActionStatus((prev) => ({ ...prev, [jobId]: "retry-ok" }));
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Network error.");
    } finally {
      clearAction(jobId);
    }
  }

  async function handleReprocess(sourceId: string, jobId: string) {
    if (!confirm("Reprocess this source? Existing chunks, pages, and documents will be removed and regenerated from the original PDF.")) return;
    setActionStatus((prev) => ({ ...prev, [jobId]: "reprocessing" }));
    try {
      const res = await fetch(`/api/admin/ingestion/sources/${sourceId}/reprocess`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Reprocess failed.");
        return;
      }
      setActionStatus((prev) => ({ ...prev, [jobId]: "reprocess-ok" }));
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Network error.");
    } finally {
      clearAction(jobId);
    }
  }

  async function handleDelete(sourceId: string, jobId: string) {
    if (!confirm("⚠️ DELETE this source permanently? This cannot be undone.")) return;
    if (!confirm("FINAL WARNING: proceed with deletion?")) return;
    setActionStatus((prev) => ({ ...prev, [jobId]: "deleting" }));
    try {
      const res = await fetch(`/api/admin/ingestion/sources/${sourceId}/delete`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error ?? "Delete failed.");
        return;
      }
      setActionStatus((prev) => ({ ...prev, [jobId]: "delete-ok" }));
      await load();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Network error.");
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
    return <p className="text-text-muted">Loading jobs…</p>;
  }

  if (error) {
    return <p className="text-danger">{error}</p>;
  }

  if (jobs.length === 0) {
    return <p className="text-text-muted">No ingestion jobs yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border bg-surface">
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Источник</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Статус</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Прогресс</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Тип</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Дата</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Ошибка</th>
            <th className="px-4 py-3 text-xs font-semibold tracking-wider text-text-muted uppercase">Действия</th>
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
                <p className="mt-1 font-mono text-[10px] text-text-muted">job {job.id.slice(0, 8)}</p>
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_STYLES[job.status] ?? "bg-surface-light text-text-muted"}`}>
                  {STATUS_LABELS[job.status] ?? job.status}
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
              <td className="px-4 py-3">
                <Actions
                  job={job}
                  actionStatus={actionStatus}
                  onRetry={handleRetry}
                  onReprocess={handleReprocess}
                  onDelete={handleDelete}
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
  onRetry,
  onReprocess,
  onDelete,
}: {
  job: JobRecord;
  actionStatus: Record<string, string>;
  onRetry: (jobId: string) => void;
  onReprocess: (sourceId: string, jobId: string) => void;
  onDelete: (sourceId: string, jobId: string) => void;
}) {
  const status = actionStatus[job.id];

  if (status === "retrying" || status === "reprocessing" || status === "deleting") {
    return <span className="text-xs text-text-muted">{status}…</span>;
  }

  if (status === "retry-ok") return <span className="text-xs font-semibold text-success">Retried ✓</span>;
  if (status === "reprocess-ok") return <span className="text-xs font-semibold text-success">Reprocessing ✓</span>;
  if (status === "delete-ok") return <span className="text-xs font-semibold text-success">Deleted ✓</span>;

  const canRetry = (job.status === "failed" || job.status === "cancelled") && job.sourceId && job.fileId;
  const canReprocess = (job.status === "succeeded" || job.status === "failed") && job.sourceId;
  const canDelete = job.sourceId;

  return (
    <div className="flex gap-1.5">
      {canRetry && <button className="rounded-md border border-warning/40 px-2 py-1 text-xs font-medium text-warning hover:bg-warning/10" onClick={() => onRetry(job.id)}>Retry</button>}
      {canReprocess && <button className="rounded-md border border-accent/40 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10" onClick={() => onReprocess(job.sourceId!, job.id)}>Reprocess</button>}
      {canDelete && <button className="rounded-md border border-danger/40 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/10" onClick={() => onDelete(job.sourceId!, job.id)}>Delete</button>}
    </div>
  );
}

function formatTimestamp(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}
