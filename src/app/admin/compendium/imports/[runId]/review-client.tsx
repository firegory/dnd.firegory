"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { useUiLanguage } from "../../../../../components/ui/i18n";

type Candidate = { id: string; candidateKey: string; entryType: string | null; diffStatus: string; content: Record<string, unknown>; previousContent: Record<string, unknown> | null; invalidReason: string | null; locator: string | null; page: number | null; decision: string; resolvedContent: Record<string, unknown> | null; publicationStatus: string; lastError: string | null; reviewedBy: string | null; reviewedAt: string | null };
type RunDetail = { run: { sourceId: string; fileId: string; sourceTitle: string; status: string; counts: Record<string, number> }; candidates: Candidate[]; diagnostics: Array<{ code: string; level: string; message: string }>; audit: Array<{ eventType: string; candidateId: string | null; actor: string; createdAt: string }> };
const FILTERS = ["", "new", "unchanged", "changed", "missing", "duplicate", "invalid"];

export function ImportRunReview({ runId }: { runId: string }) {
  const { t } = useUiLanguage();
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [bulkMerge, setBulkMerge] = useState<string | null>(null);

  async function load(signal?: AbortSignal) {
    const response = await fetch(`/api/admin/compendium/import-runs/${runId}${filter ? `?diffStatus=${filter}` : ""}`, { signal });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? t("importRunLoadFailed"));
    setDetail(body); setError(null); setSelected(new Set());
  }
  useEffect(() => { const controller = new AbortController(); const timer = setTimeout(() => { void load(controller.signal).catch((reason) => { if (reason.name !== "AbortError") setError(reason.message); }); }, 0); return () => { clearTimeout(timer); controller.abort(); }; }, [filter, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(action: string, candidateIds: string[], resolvedContent?: Record<string, unknown>, resolvedContents?: Record<string, Record<string, unknown>>) {
    if (["unpublish", "reject"].includes(action) && !confirm(t(action === "unpublish" ? "unpublishConfirm" : "rejectCandidatesConfirm", { count: candidateIds.length }))) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/admin/compendium/import-runs/${runId}/actions`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, candidateIds, resolvedContent, resolvedContents }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? t("reviewActionFailed"));
      const failures = (body.results ?? []).filter((result: { publicationStatus: string }) => result.publicationStatus === "failed");
      if (failures.length) setError(t("publicationQueueFailed", { count: failures.length }));
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("reviewActionFailed")); }
    finally { setBusy(false); }
  }

  function openBulkMerge() {
    if (!detail) return;
    setBulkMerge(JSON.stringify(Object.fromEntries(detail.candidates.filter((candidate) => selected.has(candidate.id)).map((candidate) => [candidate.id, candidate.resolvedContent ?? candidate.content])), null, 2));
  }

  async function submitBulkMerge() {
    try {
      const parsed: unknown = JSON.parse(bulkMerge ?? "");
      if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" || Object.values(parsed).some((value) => !value || Array.isArray(value) || typeof value !== "object")) throw new Error();
      await act("merge", [...selected], undefined, parsed as Record<string, Record<string, unknown>>);
      setBulkMerge(null);
    } catch { alert(t("invalidBulkMergeJson")); }
  }

  if (!detail) return <p className="text-text-muted">{error ?? t("loadingImportRun")}</p>;
  const allSelected = detail.candidates.length > 0 && detail.candidates.every((candidate) => selected.has(candidate.id));
  return <div className="space-y-6">
    <header className="border-b border-border pb-5"><Link href="/admin/compendium/imports" className="text-sm text-accent hover:underline">← {t("importReview")}</Link><div className="mt-3 flex flex-wrap items-end justify-between gap-4"><div><h1 className="text-3xl">{detail.run.sourceTitle}</h1><p className="mt-1 font-mono text-xs text-text-muted">{runId}</p></div><span className="rounded-full bg-success/15 px-3 py-1 text-sm font-bold text-success">{detail.run.status}</span></div></header>
    {error && <p role="alert" className="rounded-lg border border-danger/30 bg-danger/10 p-3 text-danger">{error}</p>}
    {detail.diagnostics.length > 0 && <details className="rounded-lg border border-warning/30 bg-warning/10 p-4"><summary className="cursor-pointer font-bold text-warning">{t("diagnostics")} ({detail.diagnostics.length})</summary><ul className="mt-3 space-y-2">{detail.diagnostics.map((diagnostic, index) => <li key={`${diagnostic.code}-${index}`} className="text-sm"><strong>{diagnostic.code}</strong>: {diagnostic.message}</li>)}</ul></details>}
    <div className="sticky top-16 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface/95 p-3 shadow-lg backdrop-blur">
      <select aria-label={t("candidateFilter")} className="rounded-md border border-border bg-surface-light px-3 py-2 text-sm" value={filter} onChange={(event) => setFilter(event.target.value)}>{FILTERS.map((value) => <option key={value} value={value}>{value || t("allCandidates")}</option>)}</select>
      <label className="mr-auto flex items-center gap-2 text-sm"><input type="checkbox" checked={allSelected} onChange={(event) => setSelected(event.target.checked ? new Set(detail.candidates.map((candidate) => candidate.id)) : new Set())} />{t("selectAll")} ({selected.size})</label>
      <button disabled={busy || selected.size === 0} onClick={() => void act("approve", [...selected])} className="rounded-md bg-success px-3 py-2 text-sm font-bold text-white disabled:opacity-40">{t("approve")}</button>
      <button disabled={busy || selected.size === 0} onClick={() => void act("reject", [...selected])} className="rounded-md border border-danger px-3 py-2 text-sm font-bold text-danger disabled:opacity-40">{t("reject")}</button>
      <button disabled={busy || selected.size === 0} onClick={openBulkMerge} className="rounded-md border border-accent px-3 py-2 text-sm font-bold text-accent disabled:opacity-40">{t("merge")}</button>
      <button disabled={busy || selected.size === 0} onClick={() => void act("unpublish", [...selected])} className="rounded-md bg-danger px-3 py-2 text-sm font-bold text-white disabled:opacity-40">{t("unpublish")}</button>
      <button disabled={busy || selected.size === 0} onClick={() => void act("retry", [...selected])} className="rounded-md bg-warning px-3 py-2 text-sm font-bold text-white disabled:opacity-40">{t("retry")}</button>
    </div>
    {bulkMerge !== null && <section className="rounded-xl border border-accent bg-surface p-4"><label className="text-sm font-bold">{t("bulkResolvedContents")}<textarea className="mt-2 h-80 w-full rounded-md border border-border bg-primary p-3 font-mono text-xs text-text-primary" value={bulkMerge} onChange={(event) => setBulkMerge(event.target.value)} /></label><div className="mt-2 flex gap-2"><button disabled={busy} onClick={() => void submitBulkMerge()} className="rounded-md bg-accent px-3 py-2 text-sm font-bold text-white">{t("publishMerge")}</button><button onClick={() => setBulkMerge(null)} className="rounded-md border border-border px-3 py-2 text-sm">{t("close")}</button></div></section>}
    <div className="space-y-4">{detail.candidates.map((candidate) => <CandidateCard key={candidate.id} candidate={candidate} sourceId={detail.run.sourceId} fileId={detail.run.fileId} selected={selected.has(candidate.id)} disabled={busy} t={t} onSelect={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(candidate.id); else next.delete(candidate.id); return next; })} onAct={(action, merged) => act(action, [candidate.id], merged)} />)}</div>
    <details className="rounded-xl border border-border bg-surface p-4"><summary className="cursor-pointer font-bold">{t("auditTrail")} ({detail.audit.length})</summary><div className="mt-3 max-h-72 overflow-auto">{detail.audit.map((event, index) => <p key={index} className="border-t border-border-light py-2 text-xs"><span className="font-mono text-accent">{event.eventType}</span> · {event.actor} · {new Date(event.createdAt).toLocaleString()}</p>)}</div></details>
  </div>;
}

function CandidateCard({ candidate, sourceId, fileId, selected, disabled, t, onSelect, onAct }: { candidate: Candidate; sourceId: string; fileId: string; selected: boolean; disabled: boolean; t: ReturnType<typeof useUiLanguage>["t"]; onSelect: (checked: boolean) => void; onAct: (action: string, merged?: Record<string, unknown>) => Promise<void> }) {
  const [mergeText, setMergeText] = useState(JSON.stringify(candidate.resolvedContent ?? candidate.content, null, 2));
  const [mergeOpen, setMergeOpen] = useState(false);
  const terminal = candidate.publicationStatus !== "idle";
  async function submitMerge() { try { const value = JSON.parse(mergeText); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); await onAct("merge", value); setMergeOpen(false); } catch { alert(t("invalidMergeJson")); } }
  return <article className={`rounded-xl border bg-surface p-4 sm:p-5 ${selected ? "border-accent" : "border-border"}`}>
    <div className="flex flex-wrap items-start gap-3"><input aria-label={t("selectCandidate")} type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} /><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-mono text-base font-bold text-text-primary">{candidate.candidateKey}</h2><Badge value={candidate.diffStatus} /><Badge value={candidate.decision} /><Badge value={candidate.publicationStatus} /></div><p className="mt-1 text-xs text-text-muted">{candidate.entryType ?? "—"} · {candidate.locator ?? t("noLocator")}</p></div></div>
    {candidate.invalidReason && <p className="mt-3 rounded-md bg-danger/10 p-3 text-sm text-danger">{candidate.invalidReason}</p>}
    {candidate.lastError && <p className="mt-3 rounded-md bg-danger/10 p-3 text-sm text-danger">{candidate.lastError}</p>}
    <div className="mt-4 grid gap-3 lg:grid-cols-2"><JsonPanel title={t("activeCandidate")} value={candidate.previousContent} empty={t("noActiveCandidate")} /><JsonPanel title={t("importCandidate")} value={candidate.content} /></div>
    {candidate.page && <details className="mt-4"><summary className="cursor-pointer text-sm font-bold text-accent">{t("citationPreview")} · {t("pageShort")} {candidate.page}</summary>
      {/* The authenticated preview endpoint cannot be delegated to the image optimizer. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img loading="lazy" className="mt-3 max-h-[34rem] w-full rounded-lg border border-border object-contain" src={`/api/citations/preview?sourceId=${sourceId}&fileId=${fileId}&page=${candidate.page}`} alt={t("candidateCitationPreview")} />
    </details>}
    {mergeOpen && <div className="mt-4"><label className="text-sm font-bold">{t("resolvedContent")}<textarea className="mt-2 h-64 w-full rounded-md border border-border bg-primary p-3 font-mono text-xs text-text-primary" value={mergeText} onChange={(event) => setMergeText(event.target.value)} /></label><button onClick={() => void submitMerge()} className="mt-2 rounded-md bg-accent px-3 py-2 text-sm font-bold text-white">{t("publishMerge")}</button></div>}
    <div className="mt-4 flex flex-wrap gap-2">
      {!terminal && ["new", "changed", "unchanged"].includes(candidate.diffStatus) && <button disabled={disabled} onClick={() => void onAct("approve")} className="rounded-md bg-success px-3 py-1.5 text-sm font-bold text-white">{t("approve")}</button>}
      {!terminal && <button disabled={disabled} onClick={() => void onAct("reject")} className="rounded-md border border-danger px-3 py-1.5 text-sm font-bold text-danger">{t("reject")}</button>}
      {!terminal && candidate.diffStatus !== "missing" && <button disabled={disabled} onClick={() => setMergeOpen((open) => !open)} className="rounded-md border border-accent px-3 py-1.5 text-sm font-bold text-accent">{t("merge")}</button>}
      {!terminal && candidate.diffStatus === "missing" && <button disabled={disabled} onClick={() => void onAct("unpublish")} className="rounded-md bg-danger px-3 py-1.5 text-sm font-bold text-white">{t("unpublish")}</button>}
      {["failed", "pending"].includes(candidate.publicationStatus) && <button disabled={disabled} onClick={() => void onAct("retry")} className="rounded-md bg-warning px-3 py-1.5 text-sm font-bold text-white">{t("retry")}</button>}
    </div>
  </article>;
}

function JsonPanel({ title, value, empty }: { title: string; value: unknown; empty?: string }) { return <section className="min-w-0"><h3 className="mb-2 text-xs font-bold tracking-wider text-text-muted uppercase">{title}</h3><pre className="max-h-80 overflow-auto rounded-lg bg-primary p-3 font-mono text-xs whitespace-pre-wrap text-text-secondary">{value == null ? empty ?? "—" : JSON.stringify(value, null, 2)}</pre></section>; }
function Badge({ value }: { value: string }) { const danger = ["invalid", "missing", "failed", "rejected", "unpublish"].includes(value); return <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${danger ? "bg-danger/15 text-danger" : "bg-accent/15 text-accent"}`}>{value}</span>; }
