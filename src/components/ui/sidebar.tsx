"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import {
  beginDrawerNavigation,
  closeModalDrawer,
  focusMainAfterNavigation,
  handleModalCancel,
  openModalDrawer,
} from "./drawer-behavior";
import type { AppLayoutRole } from "./navigation";
import { getNavigationItems, isNavigationItemActive } from "./navigation";
import { Toggle } from "./toggle";
import { useUiLanguage, type UiLanguage } from "./i18n";

function Brand({ onNavigate }: { onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const { t } = useUiLanguage();

  return (
    <Link href="/search" className="brand-lockup" aria-label={`dnd.firegory - ${t("rulesSearch")}`} onClick={(event) => onNavigate?.(event, "/search")}>
      <span className="brand-mark" aria-hidden="true">D20</span>
      <span>
        <strong>dnd<span>.firegory</span></strong>
        <small>{t("rulesSearch")}</small>
      </span>
    </Link>
  );
}

function Navigation({ userRole, onNavigate }: { userRole?: AppLayoutRole; onNavigate?: (event: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
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
                onClick={(event) => onNavigate?.(event, item.href)}
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
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  function closeDrawer(restoreFocus = true) {
    closeModalDrawer(dialogRef.current, triggerRef.current, restoreFocus);
    setOpen(false);
  }

  function handleNavigate(event: MouseEvent<HTMLAnchorElement>, href: string) {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const restoreFocus = beginDrawerNavigation(pathname, href, window.sessionStorage);
    if (restoreFocus) event.preventDefault();
    closeDrawer(restoreFocus);
  }

  useEffect(() => {
    if (!open) return;

    const desktopQuery = window.matchMedia("(min-width: 62rem)");
    const dialog = dialogRef.current;
    if (!dialog) return;
    openModalDrawer(dialog, dialog.querySelector<HTMLElement>("a, button"));

    function handleDesktopChange(event: MediaQueryListEvent) {
      if (event.matches) closeDrawer(false);
    }

    desktopQuery.addEventListener("change", handleDesktopChange);
    return () => {
      desktopQuery.removeEventListener("change", handleDesktopChange);
    };
  }, [open]);

  useEffect(() => {
    focusMainAfterNavigation(pathname, window.sessionStorage, document.getElementById("main-content"));
  }, [pathname]);

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
      <dialog
        id="mobile-navigation"
        ref={dialogRef}
        className="mobile-dialog"
        aria-label={t("primaryNavigation")}
        onCancel={(event) => handleModalCancel(event, () => closeDrawer())}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDrawer();
        }}
      >
        <aside className="mobile-drawer">
          <div className="drawer-heading">
            <Brand onNavigate={handleNavigate} />
            <button type="button" className="close-button" aria-label={t("closeNavigation")} onClick={() => closeDrawer()}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <Navigation userRole={userRole} onNavigate={handleNavigate} />
          <LanguageToggle />
        </aside>
      </dialog>
    </>
  );
}
