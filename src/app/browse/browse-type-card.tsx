"use client";

import Link from "next/link";

import type { EntityType, EntityTypeConfig } from "../../server/entities/types";
import { useUiLanguage, type TranslationKey } from "../../components/ui/i18n";

export function BrowseTypeCard({
  type,
  config,
  count,
}: {
  type: EntityType;
  config: EntityTypeConfig;
  count: number;
}) {
  const { t } = useUiLanguage();

  return (
    <Link
      href={`/browse/${config.slug}`}
      className="group block rounded-2xl border border-border bg-surface p-6 transition-colors hover:border-accent/40 hover:bg-accent/5"
    >
      <div className="flex items-start justify-between">
        <div>
          <h2 className="mt-2 text-lg font-bold text-text-primary group-hover:text-accent">
            {t(config.labelKey as TranslationKey)}
          </h2>
        </div>
        <span className="rounded-full bg-accent/15 px-3 py-1 text-sm font-bold text-accent">
          {count}
        </span>
      </div>
    </Link>
  );
}
