"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import type { AppLayoutRole } from "./app-layout";
import { Toggle } from "./toggle";
import { useUiLanguage, type UiLanguage, type TranslationKey } from "./i18n";
import { ENTITY_CONFIG, ENTITY_TYPES } from "../../server/entities/types";

const BASE_NAV_ITEMS = [
  { href: "/search", labelKey: "search" as TranslationKey },
] as const;

const ENTITY_NAV_ITEMS = ENTITY_TYPES.map((type) => ({
  href: `/browse/${ENTITY_CONFIG[type].slug}`,
  labelKey: ENTITY_CONFIG[type].labelKey,
}));

const ADMIN_NAV_ITEMS = [
  { href: "/admin/sources", labelKey: "sources" as TranslationKey },
  { href: "/admin/ingestion", labelKey: "upload" as TranslationKey },
  { href: "/admin/users", labelKey: "users" as TranslationKey },
] as const;

export function Sidebar({ userRole }: { userRole?: AppLayoutRole }) {
  const pathname = usePathname();
  const { language, setLanguage, t } = useUiLanguage();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-border bg-surface lg:w-56">
      <div className="flex h-16 items-center border-b border-border px-5">
        <div>
          <h1 className="text-lg leading-tight font-bold text-text-primary">
            dnd<span className="text-accent">.firegory</span>
          </h1>
          <p className="text-[11px] tracking-wider text-text-muted uppercase">{t("rulesSearch")}</p>
        </div>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-widest text-text-muted uppercase">
          {t("nav")}
        </p>
        <ul className="space-y-1">
          {BASE_NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                  }`}
                >
                  {t(item.labelKey)}
                </Link>
              </li>
            );
          })}
        </ul>

        <p className="mb-2 mt-4 px-3 text-[11px] font-semibold tracking-widest text-text-muted uppercase">
          {t("browse")}
        </p>
        <ul className="space-y-1">
          {ENTITY_NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                  }`}
                >
                  {t(item.labelKey as TranslationKey)}
                </Link>
              </li>
            );
          })}
        </ul>

        {userRole === "admin" && (
          <>
            <p className="mb-2 mt-4 px-3 text-[11px] font-semibold tracking-widest text-text-muted uppercase">
              {t("admin")}
            </p>
            <ul className="space-y-1">
              {ADMIN_NAV_ITEMS.map((item) => {
                const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={`block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                        active
                          ? "bg-accent/15 text-accent"
                          : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                      }`}
                    >
                      {t(item.labelKey)}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </nav>
      <div className="border-t border-border px-5 py-4">
        <Toggle
          label={t("siteLanguage")}
          value={language}
          options={[
            { value: "ru", label: "RU" },
            { value: "en", label: "EN" },
          ]}
          onChange={(value) => setLanguage(value as UiLanguage)}
        />
      </div>
    </aside>
  );
}

export function MobileHeader({ userRole }: { userRole?: AppLayoutRole }) {
  const pathname = usePathname();
  const { t } = useUiLanguage();
  const allItems = [
    ...BASE_NAV_ITEMS,
    ...ENTITY_NAV_ITEMS,
    ...(userRole === "admin" ? ADMIN_NAV_ITEMS : []),
  ];

  return (
    <header className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center gap-3 border-b border-border bg-surface/95 px-4 py-2 backdrop-blur-sm lg:hidden">
      <Link href="/search" className="font-bold text-text-primary">
        dnd<span className="text-accent">.firegory</span>
      </Link>
      <nav className="ml-auto flex flex-wrap justify-end gap-1">
        {allItems.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                active ? "bg-accent/15 text-accent" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {t(item.labelKey as TranslationKey)}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
