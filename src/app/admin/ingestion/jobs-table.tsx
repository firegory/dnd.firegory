"use client";

import { useEffect, useState, useCallback } from "react";
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

const STATUS_COLORS: Record<string, string> = {
  queued: "#fbbf24",
  processing: "#60a5fa",
  succeeded: "#34d399",
  failed: "#f87171",
  cancelled: "#94a3b8",
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

    async function initialLoad() {
      try {
        const res = await fetch("/api/admin/ingestion/jobs?limit=50");
        if (res.status === 401) {
          router.push("/login");
          return;
        }
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setError(data.error ?? "Failed to load jobs.");
          return;
        }
        setJobs(data.jobs ?? []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Network error.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    initialLoad();
    const interval = setInterval(() => {
      if (!cancelled) load();
    }, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [load, router]);

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
      setTimeout(() => {
        setActionStatus((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 3000);
    }
  }

  async function handleReprocess(sourceId: string, jobId: string) {
    if (
      !confirm(
        "Reprocess this source? Existing chunks, pages, and documents will be removed and regenerated from the original PDF.",
      )
    )
      return;
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
      setTimeout(() => {
        setActionStatus((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 3000);
    }
  }

  async function handleDelete(sourceId: string, jobId: string) {
    if (
      !confirm(
        "⚠️ DELETE this source permanently?\n\nThis will remove the source, its files, all extracted chunks/pages/documents, and original PDF from disk. This cannot be undone.",
      )
    )
      return;
    if (!confirm("FINAL WARNING: This action is irreversible. Proceed with deletion?")) return;
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
      setTimeout(() => {
        setActionStatus((prev) => {
          const next = { ...prev };
          delete next[jobId];
          return next;
        });
      }, 3000);
    }
  }

  if (loading) {
    return <p className="muted">Loading jobs…</p>;
  }

  if (error) {
    return <p className="form-error">{error}</p>;
  }

  if (jobs.length === 0) {
    return <p className="muted">No ingestion jobs yet.</p>;
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Job ID</th>
            <th>Kind</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Source</th>
            <th>Queued</th>
            <th>Finished</th>
            <th>Error</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td>
                <code>{job.id.slice(0, 8)}</code>
              </td>
              <td>{job.kind}</td>
              <td>
                <span style={{ color: STATUS_COLORS[job.status] ?? "inherit", fontWeight: 600 }}>
                  {job.status}
                </span>
              </td>
              <td>{job.progress}%</td>
              <td>
                <code>{job.sourceId?.slice(0, 8) ?? "—"}</code>
              </td>
              <td className="timestamp">{formatTimestamp(job.queuedAt)}</td>
              <td className="timestamp">{formatTimestamp(job.finishedAt)}</td>
              <td className="error-cell">{job.errorSummary ?? "—"}</td>
              <td className="actions-cell">
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
    return <span className="action-hint">{status}…</span>;
  }

  if (status === "retry-ok") return <span className="action-success">Retried ✓</span>;
  if (status === "reprocess-ok") return <span className="action-success">Reprocessing ✓</span>;
  if (status === "delete-ok") return <span className="action-success">Deleted ✓</span>;

  const canRetry = (job.status === "failed" || job.status === "cancelled") && job.sourceId && job.fileId;
  const canReprocess = (job.status === "succeeded" || job.status === "failed") && job.sourceId;
  const canDelete = job.sourceId;

  return (
    <div className="actions-group">
      {canRetry && (
        <button
          className="action-btn action-retry"
          onClick={() => onRetry(job.id)}
          title="Retry this failed job"
        >
          Retry
        </button>
      )}
      {canReprocess && (
        <button
          className="action-btn action-reprocess"
          onClick={() => onReprocess(job.sourceId!, job.id)}
          title="Reprocess this source from original PDF"
        >
          Reprocess
        </button>
      )}
      {canDelete && (
        <button
          className="action-btn action-delete"
          onClick={() => onDelete(job.sourceId!, job.id)}
          title="Delete this source and all related data"
        >
          Delete
        </button>
      )}
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
