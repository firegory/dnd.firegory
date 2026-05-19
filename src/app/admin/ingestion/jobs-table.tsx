"use client";

import { useEffect, useState } from "react";

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

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch("/api/admin/ingestion/jobs?limit=50");
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

    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

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
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.id}>
              <td><code>{job.id.slice(0, 8)}</code></td>
              <td>{job.kind}</td>
              <td>
                <span style={{ color: STATUS_COLORS[job.status] ?? "inherit", fontWeight: 600 }}>
                  {job.status}
                </span>
              </td>
              <td>{job.progress}%</td>
              <td><code>{job.sourceId?.slice(0, 8) ?? "—"}</code></td>
              <td className="timestamp">{formatTimestamp(job.queuedAt)}</td>
              <td className="timestamp">{formatTimestamp(job.finishedAt)}</td>
              <td className="error-cell">{job.errorSummary ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
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
