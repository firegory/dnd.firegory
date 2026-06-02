"use client";

import { useState } from "react";

import type { EntityRecord, EntityType } from "../../../../server/entities/types";
import { MarkdownText } from "../../../../components/ui/markdown-text";
import { useUiLanguage } from "../../../../components/ui/i18n";

export function ClassDetailClient({
  features,
  subclasses,
  entityType,
}: {
  features: readonly EntityRecord[];
  subclasses: readonly EntityRecord[];
  entityType: EntityType;
}) {
  const { t } = useUiLanguage();
  const [selectedSubclass, setSelectedSubclass] = useState<string | "__base__">("__base__");
  const [expandedFeatures, setExpandedFeatures] = useState<Set<string>>(new Set());

  const subclassNames = Array.from(
    new Set(subclasses.map((s) => s.name)),
  );

  const filteredFeatures = features.filter((f) => {
    const attrs = f.attributes as Record<string, unknown>;
    const featureSubclass = typeof attrs.subclass === "string" ? attrs.subclass : "";
    if (selectedSubclass === "__base__") {
      return !featureSubclass;
    }
    return featureSubclass === selectedSubclass;
  });

  const groupedByLevel = new Map<number, EntityRecord[]>();
  for (const f of filteredFeatures) {
    const attrs = f.attributes as Record<string, unknown>;
    const level = typeof attrs.level === "number" ? attrs.level : 0;
    if (!groupedByLevel.has(level)) groupedByLevel.set(level, []);
    groupedByLevel.get(level)!.push(f);
  }
  const sortedLevels = Array.from(groupedByLevel.keys()).sort((a, b) => a - b);

  function toggleFeature(id: string) {
    setExpandedFeatures((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <>
      {subclassNames.length > 0 && (
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-3 text-lg font-bold text-text-primary">
            {entityType === "species" ? t("speciesVariants") : t("classSubclasses")}
          </h2>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSelectedSubclass("__base__")}
              className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                selectedSubclass === "__base__"
                  ? "bg-accent/15 text-accent"
                  : "bg-surface-light text-text-secondary hover:text-text-primary"
              }`}
            >
              {entityType === "species" ? t("baseVariant") : t("baseClass")}
            </button>
            {subclassNames.map((name) => (
              <button
                key={name}
                onClick={() => setSelectedSubclass(name)}
                className={`rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                  selectedSubclass === name
                    ? "bg-accent/15 text-accent"
                    : "bg-surface-light text-text-secondary hover:text-text-primary"
                }`}
              >
                {name}
              </button>
            ))}
          </div>
        </section>
      )}

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-3 text-lg font-bold text-text-primary">
          {entityType === "species" ? t("speciesTraits") : t("classFeatures")}
        </h2>

        {filteredFeatures.length === 0 ? (
          <p className="text-sm text-text-muted">{t("noEntities")}</p>
        ) : (
          <div className="space-y-3">
            {sortedLevels.map((level) => (
              <div key={level}>
                <h3 className="mb-2 text-xs font-semibold tracking-widest text-text-muted uppercase">
                  {level > 0 ? t("levelN").replace("{n}", String(level)) : (entityType === "species" ? "" : t("baseClass"))}
                </h3>
                <div className="space-y-2">
                  {groupedByLevel.get(level)!.map((feature) => {
                    const isOpen = expandedFeatures.has(feature.id);
                    return (
                      <div
                        key={feature.id}
                        className="rounded-lg border border-border bg-surface-light"
                      >
                        <button
                          onClick={() => toggleFeature(feature.id)}
                          className="flex w-full items-center justify-between px-4 py-3 text-left"
                        >
                          <span className="text-sm font-semibold text-text-primary">
                            {feature.name}
                          </span>
                          <span className="text-xs text-text-muted">
                            {isOpen ? "\u25B2" : "\u25BC"}
                          </span>
                        </button>
                        {isOpen && feature.description && (
                          <div className="border-t border-border px-4 py-3">
                            <MarkdownText content={feature.description} />
                            {feature.pageNumbers.length > 0 && (
                              <p className="mt-2 text-xs text-text-muted">
                                p. {feature.pageNumbers.join(", ")}
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
