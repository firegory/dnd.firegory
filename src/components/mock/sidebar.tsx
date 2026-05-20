"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MockToggle } from "./toggle";

const NAV_ITEMS = [
  { href: "/mock/search", label: "Поиск", marker: "SR" },
  { href: "/mock/sources", label: "Источники", marker: "DB" },
  { href: "/mock/admin", label: "Загрузка", marker: "UP" },
] as const;

export function MockSidebar() {
  const pathname = usePathname();
  const [siteLanguage, setSiteLanguage] = useState("ru");

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-border bg-surface lg:w-56">
      <div className="flex h-16 items-center gap-3 border-b border-border px-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-accent/30 bg-accent/10 font-mono text-sm font-bold text-accent">
          D20
        </div>
        <div>
          <h1 className="text-lg leading-tight font-bold text-text-primary">
            dnd<span className="text-accent">.firegory</span>
          </h1>
          <p className="text-[11px] tracking-wider text-text-muted uppercase">
            UI Prototype
          </p>
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-widest text-text-muted uppercase">
          Навигация
        </p>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                    active
                      ? "bg-accent/15 text-accent"
                      : "text-text-secondary hover:bg-surface-light hover:text-text-primary"
                  }`}
                >
                  <span className="flex h-7 w-7 items-center justify-center rounded-md border border-border bg-primary/50 font-mono text-[10px] font-bold">
                    {item.marker}
                  </span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-border px-5 py-4">
        <MockToggle
          label="Язык сайта"
          value={siteLanguage}
          options={[
            { value: "ru", label: "RU" },
            { value: "en", label: "EN" },
          ]}
          onChange={setSiteLanguage}
        />
        <p className="text-xs text-text-muted">Mock UI · Версия 0.2</p>
        <p className="mt-1 text-xs text-text-muted">
          Палитра из firegory.site
        </p>
      </div>
    </aside>
  );
}

export function MockMobileHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-accent/30 bg-accent/10 font-mono text-xs font-bold text-accent">
        D20
      </div>
      <span className="font-bold text-text-primary">
        dnd<span className="text-accent">.firegory</span>
      </span>
      <nav className="ml-auto flex gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-2.5 py-1.5 font-mono text-xs font-bold transition-colors ${
                active
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {item.marker}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
