"use client";

import Link from "next/link";

import { useUiLanguage } from "../../components/ui/i18n";
import { SPELL_SCHOOLS } from "../../server/compendium/spell-schema";
import type { SpellListEntry, SpellListOptions } from "../../server/compendium/spell-read-service";

const SCHOOL_RU: Record<string, string> = {
  abjuration: "Ограждение", conjuration: "Вызов", divination: "Прорицание", enchantment: "Очарование",
  evocation: "Воплощение", illusion: "Иллюзия", necromancy: "Некромантия", transmutation: "Преобразование",
};

export function SpellList({
  spells, count, nextHref, options,
}: Readonly<{ spells: readonly SpellListEntry[]; count: number; nextHref: string | null; options: SpellListOptions }>) {
  const { language, t } = useUiLanguage();
  const school = (value: string) => language === "ru" ? SCHOOL_RU[value] ?? value : value[0].toUpperCase() + value.slice(1);
  return (
    <div className="spell-page">
      <header className="spell-heading">
        <p className="spell-kicker">D&D 2024</p>
        <h1>{t("spellCatalog")}</h1>
        <p>{t("spellCatalogDescription")}</p>
      </header>
      <form className="spell-filters" method="get" action="/spells">
        <label>{t("spellName")}<input name="q" defaultValue={options.query ?? ""} maxLength={120} /></label>
        <label>{t("spellClass")}<input name="class" defaultValue={options.className ?? ""} maxLength={80} /></label>
        <label>{t("castingTime")}<input name="casting" defaultValue={options.castingTime ?? ""} maxLength={120} /></label>
        <label>{t("range")}<input name="range" defaultValue={options.range ?? ""} maxLength={120} /></label>
        <label>{t("duration")}<input name="duration" defaultValue={options.duration ?? ""} maxLength={120} /></label>
        <label>{t("components")}<input name="component" defaultValue={options.components?.join(",") ?? ""} maxLength={120} /></label>
        <fieldset>
          <legend>{t("spellLevel")}</legend>
          <div className="spell-filter-grid">{Array.from({ length: 10 }, (_, level) => (
            <label key={level}><input type="checkbox" name="level" value={level} defaultChecked={options.levels?.includes(level)} />{level}</label>
          ))}</div>
        </fieldset>
        <fieldset>
          <legend>{t("spellSchool")}</legend>
          <div className="spell-filter-grid schools">{SPELL_SCHOOLS.map((value) => (
            <label key={value}><input type="checkbox" name="school" value={value} defaultChecked={options.schools?.includes(value)} />{school(value)}</label>
          ))}</div>
        </fieldset>
        <div className="spell-boolean-filters">
          <label><input type="checkbox" name="ritual" value="true" defaultChecked={options.ritual === true} />{t("spellRitual")}</label>
          <label><input type="checkbox" name="concentration" value="true" defaultChecked={options.concentration === true} />{t("spellConcentration")}</label>
        </div>
        <div className="spell-filter-actions"><button type="submit">{t("applyFilters")}</button><Link href="/spells">{t("clearFilters")}</Link></div>
      </form>
      <div className="spell-results-heading"><strong>{t("spellResults", { count })}</strong></div>
      {spells.length === 0 ? <p className="spell-empty">{t("noSpells")}</p> : (
        <ol className="spell-list">{spells.map((spell) => (
          <li key={spell.id}>
            <Link href={`/spells/${spell.id}`}>
              <span className="spell-level-badge">{spell.level}</span>
              <span className="spell-list-main"><strong>{spell.title}</strong><small>{school(spell.school)} · {spell.castingTime}</small></span>
              <span className="spell-list-flags">{spell.concentration ? "C" : ""}{spell.ritual ? "R" : ""}</span>
            </Link>
            <p>{spell.summary}</p>
            <footer>{spell.source.code ?? spell.source.title}{spell.source.revision ? ` · ${spell.source.revision}` : ""}</footer>
          </li>
        ))}</ol>
      )}
      {nextHref ? <Link className="spell-next" href={nextHref} rel="next">{t("nextPage")}</Link> : null}
    </div>
  );
}
