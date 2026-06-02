"use client";

import Link from "next/link";

import type { EntityRecord } from "../../../server/entities/types";
import { useUiLanguage } from "../../../components/ui/i18n";

export function ClassCardGrid({
  entities,
}: {
  entities: readonly EntityRecord[];
}) {
  const { t } = useUiLanguage();

  if (entities.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-surface p-8 text-center text-text-muted">
        {t("noEntities")}
      </div>
    );
  }

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {entities.map((entity) => {
        const attrs = entity.attributes as Record<string, unknown>;
        const hitDie = typeof attrs.hit_die === "string" ? attrs.hit_die : null;
        const primaryAbilities = Array.isArray(attrs.primary_ability)
          ? attrs.primary_ability as string[]
          : [];
        const savingThrows = Array.isArray(attrs.saving_throws)
          ? attrs.saving_throws as string[]
          : [];

        return (
          <Link
            key={entity.id}
            href={`/browse/class/${entity.id}`}
            className="group flex flex-col rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-accent/30"
          >
            <h3 className="text-xl font-bold text-text-primary group-hover:text-accent">
              {entity.name}
            </h3>

            {entity.description && (
              <p className="mt-2 line-clamp-3 text-sm text-text-secondary">
                {entity.description}
              </p>
            )}

            <div className="mt-auto flex flex-wrap gap-2 pt-4">
              {hitDie && (
                <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  {t("hitDie")}: {hitDie}
                </span>
              )}
              {primaryAbilities.length > 0 && (
                <span className="rounded-full bg-accent/15 px-2.5 py-0.5 text-xs font-semibold text-accent">
                  {primaryAbilities.join(", ")}
                </span>
              )}
              {savingThrows.length > 0 && (
                <span className="rounded-full bg-surface-light px-2.5 py-0.5 text-xs font-medium text-text-muted">
                  {t("savingThrows")}: {savingThrows.join(", ")}
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
