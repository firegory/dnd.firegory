"use client";

import Link from "next/link";

import { useUiLanguage } from "../../../components/ui/i18n";
import type { SpellDetail as SpellDetailValue } from "../../../server/compendium/spell-read-service";

export function SpellDetail({ spell }: Readonly<{ spell: SpellDetailValue }>) {
  const { language, t } = useUiLanguage();
  const schools: Record<string, readonly [string, string]> = {
    abjuration: ["Ограждение", "Abjuration"], conjuration: ["Вызов", "Conjuration"], divination: ["Прорицание", "Divination"],
    enchantment: ["Очарование", "Enchantment"], evocation: ["Воплощение", "Evocation"], illusion: ["Иллюзия", "Illusion"],
    necromancy: ["Некромантия", "Necromancy"], transmutation: ["Преобразование", "Transmutation"],
  };
  const localize = (pair: readonly [string, string] | undefined, fallback: string) => pair?.[language === "ru" ? 0 : 1] ?? fallback;
  const spellClass = (value: string) => localize(value === "class:17" ? ["Следопыт", "Ranger"] : undefined, `${t("spellClass")} ${value.replace(/^class:/, "")}`);
  const facts = [
    [t("spellLevel"), String(spell.level)], [t("spellSchool"), localize(schools[spell.school], spell.school)],
    [t("castingTime"), spell.castingTime], [t("range"), spell.range],
    [t("duration"), spell.duration], [t("components"), spell.components],
    [t("spellRitual"), spell.ritual ? t("yes") : t("no")],
    [t("spellConcentration"), spell.concentration ? t("yes") : t("no")],
  ];
  return (
    <article className="spell-detail">
      <Link className="spell-back print-action" href="/spells">← {t("backToSpells")}</Link>
      <header><span className="spell-level-badge">{spell.level}</span><div><p>D&D {spell.edition}</p><h1>{spell.title}</h1></div></header>
      <dl className="spell-facts">{facts.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {spell.classes.length ? <section><h2>{t("classes")}</h2><p>{spell.classes.map(spellClass).join(", ")}</p></section> : null}
      {spell.aliases.length ? <section><h2>{t("aliases")}</h2><p>{spell.aliases.join(", ")}</p></section> : null}
      <section className="spell-body"><p>{spell.body}</p></section>
      <section><h2>{t("sourceVersions")}</h2><ul>{spell.sourceVersions.map((source) => (
        <li key={`${source.sourceId}-${source.revisionId}`}>{source.code ?? source.title}{source.revision ? ` · ${source.revision}` : ""} · <code>{source.revisionId}</code></li>
      ))}</ul></section>
      {spell.sourceVersion ? <section><h2>{t("collectorVersion")}</h2><p><a href={spell.sourceVersion.url} target="_blank" rel="noreferrer">{spell.sourceVersion.url}</a></p><code>{spell.sourceVersion.fingerprintSha256}</code></section> : null}
      <section className="spell-citations"><h2>{t("citations")}</h2>{spell.citations.map((citation) => (
        <blockquote key={citation.id}><p>“{citation.quote}”</p><footer>{citation.section}{citation.page === null ? "" : ` · ${t("pageShort")} ${citation.page}`}{citation.previewUrl ? <> · <a className="print-action" href={citation.previewUrl} target="_blank" rel="noreferrer">{t("openPdfCitation")}</a></> : citation.sourceUrl ? <> · <a className="print-action" href={citation.sourceUrl} target="_blank" rel="noreferrer">{t("openExternalCitation")}</a></> : null} · <a className="print-action" href={citation.sourceDetailUrl}>{t("sourceDetails")}</a></footer></blockquote>
      ))}</section>
    </article>
  );
}
