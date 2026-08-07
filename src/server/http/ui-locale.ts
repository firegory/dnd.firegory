export type PathLocale = "ru" | "en";

export function uiLocaleForPathname(pathname: string): PathLocale {
  const locale = pathname.match(/^\/(ru|en)(?:\/|$)/)?.[1];
  return locale === "en" ? "en" : "ru";
}
