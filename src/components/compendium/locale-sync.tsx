"use client";

import { useEffect } from "react";

import { useUiLanguage, type UiLanguage } from "../ui/i18n";

export function LocaleSync({ locale }: { locale: UiLanguage }) {
  const { language, setLanguage } = useUiLanguage();
  useEffect(() => {
    if (language !== locale) setLanguage(locale);
  }, [language, locale, setLanguage]);
  return null;
}
