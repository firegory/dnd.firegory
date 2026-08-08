export type AppLayoutRole = "user" | "premium" | "admin";

export type NavigationItem = {
  href: string;
  labelKey: "compendium" | "search" | "spells" | "bestiary" | "feats" | "backgrounds" | "magicItems" | "equipment" | "glossary" | "settings" | "sources" | "upload" | "users" | "importReview" | "structuredEditor";
};
const ADMIN_NAV_ITEMS: readonly NavigationItem[] = [
  { href: "/admin/sources", labelKey: "sources" },
  { href: "/admin/ingestion", labelKey: "upload" },
  { href: "/admin/compendium/imports", labelKey: "importReview" },
  { href: "/admin/compendium/entries", labelKey: "structuredEditor" },
  { href: "/admin/users", labelKey: "users" },
];

export function getNavigationItems(userRole?: AppLayoutRole, locale: "ru" | "en" = "ru"): readonly NavigationItem[] {
  const base: readonly NavigationItem[] = [
    { href: `/${locale}/compendium`, labelKey: "compendium" },
    { href: "/search", labelKey: "search" },
    { href: "/spells", labelKey: "spells" },
    { href: "/bestiary", labelKey: "bestiary" },
    { href: "/feats", labelKey: "feats" },
    { href: "/backgrounds", labelKey: "backgrounds" },
    { href: "/items", labelKey: "magicItems" },
    { href: "/equipment", labelKey: "equipment" },
    { href: "/glossary", labelKey: "glossary" },
    { href: "/settings", labelKey: "settings" },
  ];
  return userRole === "admin" ? [...base, ...ADMIN_NAV_ITEMS] : base;
}

export function isNavigationItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
