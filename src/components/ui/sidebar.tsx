"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import type { AppLayoutRole } from "./navigation";
import { getNavigationItems, isNavigationItemActive } from "./navigation";
import { Toggle } from "./toggle";
import { useUiLanguage, type UiLanguage } from "./i18n";

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useUiLanguage();

  return (
    <Link href="/search" className="brand-lockup" aria-label={`dnd.firegory - ${t("rulesSearch")}`} onClick={onNavigate}>
      <span className="brand-mark" aria-hidden="true">D20</span>
      <span>
        <strong>dnd<span>.firegory</span></strong>
        <small>{t("rulesSearch")}</small>
      </span>
    </Link>
  );
}

function Navigation({ userRole, onNavigate }: { userRole?: AppLayoutRole; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { t } = useUiLanguage();

  return (
    <nav className="shell-navigation" aria-label={t("primaryNavigation")}>
      <p>{t("nav")}</p>
      <ul>
        {getNavigationItems(userRole).map((item) => {
          const active = isNavigationItemActive(pathname, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={active ? "active" : undefined}
                onClick={onNavigate}
              >
                <span className="nav-glyph" aria-hidden="true" />
                {t(item.labelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function LanguageToggle() {
  const { language, setLanguage, t } = useUiLanguage();

  return (
    <div className="sidebar-language">
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
  );
}

export function Sidebar({ userRole }: { userRole?: AppLayoutRole }) {
  return (
    <aside className="sidebar-panel">
      <Brand />
      <Navigation userRole={userRole} />
      <LanguageToggle />
    </aside>
  );
}

export function MobileHeader({ userRole }: { userRole?: AppLayoutRole }) {
  const { t } = useUiLanguage();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);

  function closeDrawer(restoreFocus = true) {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    const desktopQuery = window.matchMedia("(min-width: 62rem)");
    document.body.style.overflow = "hidden";
    drawerRef.current?.querySelector<HTMLElement>("a, button")?.focus();

    function handleDesktopChange(event: MediaQueryListEvent) {
      if (event.matches) setOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeDrawer();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;

      const focusable = Array.from(
        drawerRef.current.querySelectorAll<HTMLElement>('a, button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    desktopQuery.addEventListener("change", handleDesktopChange);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      desktopQuery.removeEventListener("change", handleDesktopChange);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <>
      <header className="mobile-header">
        <Brand />
        <button
          ref={triggerRef}
          type="button"
          className="menu-button"
          aria-expanded={open}
          aria-controls="mobile-navigation"
          aria-label={t("openNavigation")}
          onClick={() => setOpen(true)}
        >
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <span aria-hidden="true" />
        </button>
      </header>
      {open ? (
        <div className="drawer-layer">
          <button className="drawer-backdrop" type="button" aria-label={t("closeNavigation")} onClick={() => closeDrawer()} />
          <aside
            id="mobile-navigation"
            ref={drawerRef}
            className="mobile-drawer"
            role="dialog"
            aria-modal="true"
            aria-label={t("primaryNavigation")}
          >
            <div className="drawer-heading">
              <Brand onNavigate={() => closeDrawer(false)} />
              <button type="button" className="close-button" aria-label={t("closeNavigation")} onClick={() => closeDrawer()}>
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <Navigation userRole={userRole} onNavigate={() => closeDrawer(false)} />
            <LanguageToggle />
          </aside>
        </div>
      ) : null}
    </>
  );
}
