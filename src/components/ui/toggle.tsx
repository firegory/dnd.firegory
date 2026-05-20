"use client";

export type ToggleOption = { value: string; label: string };

export function Toggle({ label, value, options, onChange, className = "", disabled = false }: { label: string; value: string; options: readonly [ToggleOption, ToggleOption]; onChange: (value: string) => void; className?: string; disabled?: boolean }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-semibold tracking-wide text-text-muted uppercase">{label}</span>
      <div role="radiogroup" aria-label={label} aria-disabled={disabled} className={`relative grid min-w-36 grid-cols-2 rounded-full border border-border bg-primary/60 p-1 ${disabled ? "opacity-60" : ""}`}>
        <span aria-hidden="true" className={`absolute top-1 bottom-1 w-[calc(50%-0.25rem)] rounded-full bg-accent shadow-lg shadow-accent/20 transition-transform duration-200 ease-out ${value === options[1].value ? "translate-x-full" : "translate-x-0"}`} />
        {options.map((option) => {
          const active = option.value === value;
          return <button key={option.value} type="button" role="radio" aria-checked={active} disabled={disabled} onClick={() => onChange(option.value)} className={`relative z-10 rounded-full px-3 py-1.5 text-sm font-semibold transition-colors disabled:cursor-wait ${active ? "text-primary" : "text-text-muted hover:text-text-primary"}`}>{option.label}</button>;
        })}
      </div>
    </div>
  );
}
