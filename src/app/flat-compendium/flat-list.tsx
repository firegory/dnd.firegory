"use client";

import Link from "next/link";

import { useUiLanguage } from "../../components/ui/i18n";
import type { FlatListEntry, FlatListOptions } from "../../server/compendium/flat-read-service";
import { flatCollection, type FlatEntryType } from "../../server/compendium/flat-schema";

const TITLES: Readonly<Record<FlatEntryType, readonly [string, string]>> = {
  feat: ["Черты", "Feats"], background: ["Предыстории", "Backgrounds"], item: ["Магические предметы", "Magic items"],
  equipment: ["Снаряжение", "Equipment"], glossary: ["Глоссарий", "Glossary"],
};
const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  category: ["Категория", "Category"], rarity: ["Редкость", "Rarity"], prerequisiteLevel: ["Уровень требования", "Prerequisite level"],
  prerequisiteText: ["Требование", "Prerequisite"], repeatable: ["Повторяемая", "Repeatable"], abilityScores: ["Характеристики", "Ability scores"],
  skillProficiencies: ["Владение навыками", "Skill proficiencies"], requiresAttunement: ["Настройка", "Attunement"], costCp: ["Стоимость (мм)", "Cost (cp)"],
  weightLb: ["Вес (фунты)", "Weight (lb)"], relatedTerms: ["Связанные термины", "Related terms"],
};

export function FlatList({ type, entries, count, options, nextHref }: Readonly<{ type: FlatEntryType; entries: readonly FlatListEntry[]; count: number; options: FlatListOptions; nextHref: string | null }>) {
  const { language, t } = useUiLanguage(); const index = language === "ru" ? 0 : 1; const collection = flatCollection(type);
  const label = (key: string) => LABELS[key]?.[index] ?? key;
  return <div className="flat-page">
    <header className="flat-heading"><p>D&D 2024</p><h1>{TITLES[type][index]}</h1><p>{language === "ru" ? "Проверенные записи из доступных вам источников." : "Reviewed entries from sources available to you."}</p></header>
    <form className="flat-filters" method="get" action={`/${collection}`}>
      <label>{language === "ru" ? "Название или псевдоним" : "Name or alias"}<input name="q" defaultValue={options.query ?? ""} maxLength={120} /></label>
      <label>{label("category")}<input name="category" defaultValue={options.entryCategory ?? ""} maxLength={120} /></label>
      {type === "item" ? <><label>{label("rarity")}<input name="rarity" defaultValue={options.rarity ?? ""} maxLength={120} /></label><BooleanFilter name="attunement" value={options.attunement} label={label("requiresAttunement")} /></> : null}
      {type === "feat" ? <><label>{label("prerequisiteLevel")}<span className="flat-range"><input name="minLevel" inputMode="numeric" defaultValue={options.minLevel ?? ""} /><input name="maxLevel" inputMode="numeric" defaultValue={options.maxLevel ?? ""} /></span></label><BooleanFilter name="repeatable" value={options.repeatable} label={label("repeatable")} /></> : null}
      {type === "background" ? <><label>{label("abilityScores")}<input name="ability" defaultValue={options.ability ?? ""} /></label><label>{label("skillProficiencies")}<input name="skill" defaultValue={options.skill ?? ""} /></label></> : null}
      {type === "equipment" ? <><Range name="Cost" min={options.minCost} max={options.maxCost} label={label("costCp")} /><Range name="Weight" min={options.minWeight} max={options.maxWeight} label={label("weightLb")} /></> : null}
      {type === "glossary" ? <label>{label("relatedTerms")}<input name="related" defaultValue={options.related ?? ""} /></label> : null}
      <label>{language === "ru" ? "Язык источника" : "Source language"}<select name="language" defaultValue={options.language ?? ""}><option value="">{t("anyValue")}</option><option value="ru">Русский</option><option value="en">English</option></select></label>
      <div className="flat-actions"><button type="submit">{t("applyFilters")}</button><Link href={`/${collection}`}>{t("clearFilters")}</Link></div>
    </form>
    <strong className="flat-count">{language === "ru" ? `Найдено: ${count}` : `Found: ${count}`}</strong>
    {entries.length ? <ol className="flat-list">{entries.map((entry) => <li key={entry.id}><Link href={`/${collection}/${entry.id}`}><h2>{entry.title}</h2><p>{entry.summary}</p><dl>{Object.entries(entry.projection).filter(([key]) => key !== "type").slice(0, 3).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{display(value, language)}</dd></div>)}</dl><footer>{entry.source.code ?? entry.source.title}{entry.source.revision ? ` · ${entry.source.revision}` : ""}</footer></Link></li>)}</ol> : <p>{language === "ru" ? "Доступные записи не найдены." : "No accessible entries found."}</p>}
    {nextHref ? <Link className="flat-next" href={nextHref} rel="next">{t("nextPage")}</Link> : null}
  </div>;
}

function BooleanFilter({ name, value, label }: Readonly<{ name: string; value: boolean | undefined; label: string }>) { const { t } = useUiLanguage(); return <label>{label}<select name={name} defaultValue={value === undefined ? "" : String(value)}><option value="">{t("anyValue")}</option><option value="true">{t("yes")}</option><option value="false">{t("no")}</option></select></label>; }
function Range({ name, min, max, label }: Readonly<{ name: string; min: number | undefined; max: number | undefined; label: string }>) { return <label>{label}<span className="flat-range"><input name={`min${name}`} inputMode="decimal" defaultValue={min ?? ""} /><input name={`max${name}`} inputMode="decimal" defaultValue={max ?? ""} /></span></label>; }
function display(value: unknown, language: "ru" | "en"): string { if (Array.isArray(value)) return value.join(", "); if (typeof value === "boolean") return language === "ru" ? value ? "Да" : "Нет" : value ? "Yes" : "No"; return value === null ? "—" : String(value); }
