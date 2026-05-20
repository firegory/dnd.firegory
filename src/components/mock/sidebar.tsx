"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/mock", label: "Главная", icon: "🏠" },
  { href: "/mock/search", label: "Поиск", icon: "🔍" },
  { href: "/mock/admin", label: "Загрузка", icon: "📤" },
  { href: "/mock/source/src-1", label: "Источник", icon: "📖" },
] as const;

export function MockSidebar() {
  const pathname = usePathname();

  return (
    <aside className="fixed inset-y-0 left-0 z-30 flex w-64 flex-col border-r border-border bg-surface lg:w-56">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 border-b border-border px-5">
        <span className="text-2xl">🐉</span>
        <div>
          <h1 className="text-lg font-bold text-text-primary leading-tight">
            dnd<span className="text-accent">.firegory</span>
          </h1>
          <p className="text-[11px] tracking-wider text-text-muted uppercase">
            UI Prototype
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <p className="mb-2 px-3 text-[11px] font-semibold tracking-widest text-text-muted uppercase">
          Навигация
        </p>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || (item.href !== "/mock" && pathname.startsWith(item.href));
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
                  <span className="text-base">{item.icon}</span>
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {/* Footer */}
      <div className="border-t border-border px-5 py-4">
        <p className="text-xs text-text-muted">
          Mock UI · Версия 0.1
        </p>
        <p className="text-xs text-text-muted mt-1">
          Цветовая палитра из firegory.site
        </p>
      </div>
    </aside>
  );
}

export function MockMobileHeader() {
  const pathname = usePathname();

  return (
    <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-border bg-surface/95 px-4 backdrop-blur-sm lg:hidden">
      <span className="text-xl">🐉</span>
      <span className="font-bold text-text-primary">
        dnd<span className="text-accent">.firegory</span>
      </span>
      <nav className="ml-auto flex gap-1">
        {NAV_ITEMS.map((item) => {
          const active = pathname === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                active
                  ? "bg-accent/15 text-accent"
                  : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {item.icon}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
