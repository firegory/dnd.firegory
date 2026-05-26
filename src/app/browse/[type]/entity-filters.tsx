"use client";

import { useRouter, useSearchParams } from "next/navigation";

import type { EntityTypeConfig } from "../../../server/entities/types";
import { AppSelect, type SelectOption } from "../../../components/ui/select";
import { useUiLanguage, type TranslationKey } from "../../../components/ui/i18n";

export function EntityFilters({
  typeSlug,
  config,
  currentFilters,
}: {
  typeSlug: string;
  config: EntityTypeConfig;
  currentFilters: Record<string, string>;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useUiLanguage();

  function updateFilter(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete("page");
    router.push(`/browse/${typeSlug}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap gap-3">
      {config.filters.map((filterDef) => {
        const options: SelectOption[] = (filterDef.options ?? []).map((opt) => ({
          value: opt.value,
          label: t(opt.labelKey as TranslationKey),
        }));

        return (
          <AppSelect
            key={filterDef.key}
            label={t(filterDef.labelKey as TranslationKey)}
            value={currentFilters[filterDef.key] ?? ""}
            options={options}
            onChange={(value) => updateFilter(filterDef.key, value)}
          />
        );
      })}
    </div>
  );
}
