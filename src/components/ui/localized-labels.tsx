"use client";

import { accessTierLabel, categoryLabel, languageLabel, jobStatusLabel, useUiLanguage } from "./i18n";

export function CategoryLabel({ value }: { value: string }) {
  const { language } = useUiLanguage();
  return <>{categoryLabel(value, language)}</>;
}

export function SourceLanguageLabel({ value }: { value: string }) {
  const { language } = useUiLanguage();
  return <>{languageLabel(value, language)}</>;
}

export function AccessTierLabel({ value }: { value: string }) {
  const { language } = useUiLanguage();
  return <>{accessTierLabel(value, language)}</>;
}

export function JobStatusLabel({ value }: { value: string }) {
  const { language, t } = useUiLanguage();
  return <>{value ? jobStatusLabel(value, language) : t("noJobsStatus")}</>;
}
