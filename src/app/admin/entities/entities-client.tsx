"use client";

import { useState, useCallback } from "react";

import { ENTITY_TYPES, type EntityType, type EntityRecord } from "../../../server/entities/types";
import { useUiLanguage } from "../../../components/ui/i18n";

export function AdminEntitiesClient() {
  const { t } = useUiLanguage();
  const [selectedType, setSelectedType] = useState<EntityType>("spell");
  const [entities, setEntities] = useState<readonly EntityRecord[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [targetId, setTargetId] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [merging, setMerging] = useState(false);
  const [message, setMessage] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const fetchEntities = useCallback(async () => {
    setLoading(true);
    setMessage(null);
    setSelectedIds(new Set());
    setTargetId("");
    try {
      const res = await fetch(`/api/admin/entities/list?entityType=${selectedType}`);
      if (!res.ok) {
        setMessage({ type: "err", text: t("mergeError") });
        return;
      }
      const data = await res.json();
      if (data.items) setEntities(data.items);
    } catch {
      setMessage({ type: "err", text: t("mergeError") });
    } finally {
      setLoading(false);
    }
  }, [selectedType, t]);

  const handleMerge = async () => {
    if (!targetId || selectedIds.size < 2) {
      setMessage({ type: "err", text: t("noEntitiesToMerge") });
      return;
    }

    const sourceIds = Array.from(selectedIds).filter((id) => id !== targetId);
    if (sourceIds.length === 0) {
      setMessage({ type: "err", text: t("noEntitiesToMerge") });
      return;
    }

    setMerging(true);
    try {
      const res = await fetch("/api/admin/entities/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetId, sourceIds }),
      });
      const data = await res.json();
      if (data.ok) {
        setMessage({ type: "ok", text: t("mergeSuccess") });
        await fetchEntities();
      } else {
        setMessage({ type: "err", text: data.error || t("mergeError") });
      }
    } catch {
      setMessage({ type: "err", text: t("mergeError") });
    } finally {
      setMerging(false);
    }
  };

  function toggleEntity(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex items-end gap-4">
        <div>
          <label className="mb-1 block text-xs font-semibold tracking-wide text-text-muted uppercase">
            {t("selectEntityType")}
          </label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as EntityType)}
            className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
          >
            {ENTITY_TYPES.map((type) => (
              <option key={type} value={type}>
                {type.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>
        <button
          onClick={fetchEntities}
          disabled={loading}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
        >
          {loading ? "..." : t("selectEntityType")}
        </button>
      </div>

      {message && (
        <div
          className={`rounded-lg px-4 py-2 text-sm ${
            message.type === "ok"
              ? "bg-green-500/15 text-green-400"
              : "bg-red-500/15 text-red-400"
          }`}
        >
          {message.text}
        </div>
      )}

      {entities.length > 0 && (
        <>
          <div className="rounded-xl border border-border bg-surface">
            <div className="border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold text-text-primary">
                {entities.length} entities &middot; {selectedIds.size} selected
              </h2>
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {entities.map((entity) => (
                <label
                  key={entity.id}
                  className="flex cursor-pointer items-center gap-3 border-b border-border px-5 py-3 last:border-b-0 hover:bg-surface-light"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(entity.id)}
                    onChange={() => toggleEntity(entity.id)}
                    className="accent-accent"
                  />
                  <input
                    type="radio"
                    name="target"
                    checked={targetId === entity.id}
                    onChange={() => setTargetId(entity.id)}
                    className="accent-accent"
                    title={t("selectTarget")}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-text-primary">{entity.name}</p>
                    <p className="text-xs text-text-muted">
                      {entity.description ? entity.description.slice(0, 100) : ""}
                      {entity.description && entity.description.length > 100 ? "..." : ""}
                    </p>
                  </div>
                  <span className="text-xs text-text-muted">
                    {entity.pageNumbers.length > 0 && `p. ${entity.pageNumbers.join(", ")}`}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-4">
            <p className="text-xs text-text-muted">
              {t("selectTarget")} &mdash; {t("mergeEntities")}
            </p>
            <button
              onClick={handleMerge}
              disabled={merging || selectedIds.size < 2 || !targetId}
              className="rounded-lg bg-accent px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {merging ? "..." : t("merge")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
