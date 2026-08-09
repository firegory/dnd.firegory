"use client";

import { useId, useRef, useState } from "react";

export type SelectOption = { value: string; label: string; description?: string };

export function AppSelect({ label, value, options, onChange, className = "", disabled = false }: { label: string; value: string; options: readonly SelectOption[]; onChange: (value: string) => void; className?: string; disabled?: boolean }) {
  const id = useId();
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value) ?? options[0];
  function scheduleClose() { closeTimer.current = setTimeout(() => setOpen(false), 120); }
  function cancelClose() { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } }
  return (
    <div className={`relative flex flex-col gap-1.5 ${className}`} onBlur={scheduleClose} onFocus={cancelClose}>
      <span id={`${id}-label`} className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>
      <button type="button" disabled={disabled} aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-label ${id}-value`} onClick={() => setOpen((current) => !current)} className="group flex min-w-40 items-center justify-between gap-3 rounded-lg border border-border bg-primary/60 px-3 py-2 text-left text-sm text-text-primary outline-none transition-colors hover:border-accent/50 focus:border-focus focus:ring-2 focus:ring-focus/20 disabled:cursor-wait disabled:opacity-60">
        <span id={`${id}-value`} className="truncate">{selected?.label ?? "—"}</span>
        <span aria-hidden="true" className={`h-2 w-2 shrink-0 rotate-45 border-r-2 border-b-2 border-text-muted transition-transform group-hover:border-accent ${open ? "-translate-y-0.5 rotate-[225deg]" : "translate-y-[-2px]"}`} />
      </button>
      {open && !disabled && (
        <div className="absolute top-full z-40 mt-2 w-full min-w-56 overflow-hidden rounded-xl border border-border bg-surface shadow-2xl shadow-black/35">
          <ul role="listbox" aria-labelledby={`${id}-label`} className="max-h-64 overflow-y-auto py-1">
            {options.map((option) => {
              const active = option.value === selected?.value;
              return <li key={option.value} role="option" aria-selected={active}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(option.value); setOpen(false); }} className={`w-full px-3 py-2.5 text-left text-sm transition-colors ${active ? "bg-accent/15 text-accent" : "text-text-secondary hover:bg-surface-light hover:text-text-primary"}`}><span className="block font-medium">{option.label}</span>{option.description && <span className="mt-0.5 block text-xs text-text-muted">{option.description}</span>}</button></li>;
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
