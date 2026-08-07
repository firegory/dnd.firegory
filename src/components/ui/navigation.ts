export type AppLayoutRole = "user" | "premium" | "admin";

export type NavigationItem = {
  href: string;
  labelKey: "search" | "spells" | "settings" | "sources" | "upload" | "users" | "importReview";
};

const BASE_NAV_ITEMS: readonly NavigationItem[] = [
  { href: "/search", labelKey: "search" },
  { href: "/spells", labelKey: "spells" },
  { href: "/settings", labelKey: "settings" },
];

const ADMIN_NAV_ITEMS: readonly NavigationItem[] = [
  { href: "/admin/sources", labelKey: "sources" },
  { href: "/admin/ingestion", labelKey: "upload" },
  { href: "/admin/compendium/imports", labelKey: "importReview" },
  { href: "/admin/users", labelKey: "users" },
];

export function getNavigationItems(userRole?: AppLayoutRole): readonly NavigationItem[] {
  return userRole === "admin" ? [...BASE_NAV_ITEMS, ...ADMIN_NAV_ITEMS] : BASE_NAV_ITEMS;
}

export function isNavigationItemActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
