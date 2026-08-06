"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useUiLanguage } from "../../../../components/ui/i18n";

type Run = { id: string; sourceTitle: string; status: string; createdAt: string; counts: Record<string, number> };

export function ImportRunsDashboard() {
  const { t } = useUiLanguage();
  const [runs, setRuns] = useState<Run[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/admin/compendium/import-runs${status ? `?status=${status}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? t("importRunsLoadFailed"));
        setRuns(body.runs ?? []); setError(null);
      })
      .catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [status, t]);

  return <div className="space-y-6">
    <header className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-5">
      <div><p className="text-xs font-bold tracking-[.18em] text-accent uppercase">{t("admin")}</p><h1 className="mt-1 text-3xl text-text-primary">{t("importReview")}</h1><p className="mt-2 max-w-2xl text-sm text-text-muted">{t("importReviewDescription")}</p></div>
      <label className="text-sm text-text-secondary">{t("status")}<select className="ml-2 rounded-md border border-border bg-surface px-3 py-2" value={status} onChange={(event) => { setLoading(true); setStatus(event.target.value); }}><option value="">{t("allStatuses")}</option>{["pending", "running", "succeeded", "failed", "cancelled"].map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
    </header>
    {loading && <p className="text-text-muted">{t("loadingImportRuns")}</p>}
    {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-4 text-danger">{error}</p>}
    {!loading && !error && runs.length === 0 && <p className="text-text-muted">{t("noImportRuns")}</p>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{runs.map((run) => <Link key={run.id} href={`/admin/compendium/imports/${run.id}`} className="group rounded-xl border border-border bg-surface p-5 transition hover:-translate-y-0.5 hover:border-accent/60">
      <div className="flex items-start justify-between gap-3"><h2 className="text-lg text-text-primary group-hover:text-accent">{run.sourceTitle}</h2><span className={`rounded-full px-2.5 py-1 text-xs font-bold ${run.status === "succeeded" ? "bg-success/15 text-success" : run.status === "failed" ? "bg-danger/15 text-danger" : "bg-warning/15 text-warning"}`}>{run.status}</span></div>
      <p className="mt-1 font-mono text-[11px] text-text-muted">{run.id}</p>
      <div className="mt-5 grid grid-cols-3 gap-2 text-center"><Metric label={t("changedCandidates")} value={run.counts.changed} /><Metric label={t("missingCandidates")} value={run.counts.missing} /><Metric label={t("invalidCandidates")} value={run.counts.invalid} /></div>
      <div className="mt-4 flex justify-between border-t border-border-light pt-3 text-xs text-text-muted"><span>{new Date(run.createdAt).toLocaleString()}</span><span>{run.counts.pending} {t("pendingReview")}</span></div>
    </Link>)}</div>
  </div>;
}

function Metric({ label, value }: { label: string; value: number }) { return <div className="rounded-md bg-surface-light p-2"><strong className="block text-lg text-text-primary">{value}</strong><span className="text-[10px] text-text-muted">{label}</span></div>; }
