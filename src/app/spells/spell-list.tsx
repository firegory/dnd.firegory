"use client";

import Link from "next/link";

import { useUiLanguage } from "../../components/ui/i18n";
import { SPELL_SCHOOLS } from "../../server/compendium/spell-schema";
import type { SpellListEntry, SpellListOptions } from "../../server/compendium/spell-read-service";

const SCHOOL_RU: Record<string, string> = {
  abjuration: "Ограждение", conjuration: "Вызов", divination: "Прорицание", enchantment: "Очарование",
  evocation: "Воплощение", illusion: "Иллюзия", necromancy: "Некромантия", transmutation: "Преобразование",
};

const CLASS_NAMES: Record<string, readonly [string, string]> = {
  "class:17": ["Следопыт", "Ranger"],
};

export function SpellList({
  spells, count, nextHref, options,
}: Readonly<{ spells: readonly SpellListEntry[]; count: number; nextHref: string | null; options: SpellListOptions }>) {
  const { language, t } = useUiLanguage();
  const school = (value: string) => language === "ru" ? SCHOOL_RU[value] ?? value : value[0].toUpperCase() + value.slice(1);
  const spellClass = (value: string) => CLASS_NAMES[value]?.[language === "ru" ? 0 : 1]
    ?? `${t("spellClass")} ${value.replace(/^class:/, "")}`;
  return (
    <div className="spell-page">
      <header className="spell-heading">
        <p className="spell-kicker">D&D 2024</p>
        <h1>{t("spellCatalog")}</h1>
        <p>{t("spellCatalogDescription")}</p>
      </header>
      <form className="spell-filters" method="get" action="/spells">
        <label>{t("spellName")}<input name="q" defaultValue={options.query ?? ""} maxLength={120} /></label>
        <label>{t("spellClass")}<input name="class" defaultValue={options.className ?? ""} maxLength={80} list="spell-classes" /><datalist id="spell-classes"><option value="class:17">{spellClass("class:17")}</option></datalist></label>
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
          <label>{t("spellRitual")}<select name="ritual" defaultValue={options.ritual === undefined ? "" : String(options.ritual)}><option value="">{t("anyValue")}</option><option value="true">{t("yes")}</option><option value="false">{t("no")}</option></select></label>
          <label>{t("spellConcentration")}<select name="concentration" defaultValue={options.concentration === undefined ? "" : String(options.concentration)}><option value="">{t("anyValue")}</option><option value="true">{t("yes")}</option><option value="false">{t("no")}</option></select></label>
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
              <span className="spell-list-flags">{[spell.concentration ? t("spellConcentration") : "", spell.ritual ? t("spellRitual") : ""].filter(Boolean).join(" · ")}</span>
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
